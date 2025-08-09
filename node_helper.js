
/* eslint-disable no-console */
const NodeHelper = require("node_helper");
const path = require("path");
const fs = require("fs");

let sharp = null;

module.exports = NodeHelper.create({
  start() {
    this.config = null;
    this.files = [];
    this.version = 0;
    this.lastScanTs = 0;
    this._routeReady = false;
  },

  socketNotificationReceived(n, payload) {
    if (n === "PF_CONFIG") {
      if (!payload.folder) {
        payload.folder = path.join(__dirname, "uploads");
      }
      this.config = payload;

      try {
        if (!fs.existsSync(this.config.folder)) {
          fs.mkdirSync(this.config.folder, { recursive: true });
          console.log("[MMM-PhotoRoll] Created uploads folder:", this.config.folder);
        }
      } catch (err) {
        console.warn("[MMM-PhotoRoll] Cannot create uploads folder:", err.message);
      }

      if (this.config.useThumbnails) {
        try {
          sharp = require("sharp");
          console.log("[MMM-PhotoRoll] sharp enabled");
        } catch (e) {
          sharp = null;
          console.warn("[MMM-PhotoRoll] sharp not installed, disabling thumbnails");
          this.config.useThumbnails = false;
        }
      }

      this._setupRoutes();
    } else if (n === "PF_SCAN") {
      this._scanIfNeeded();
    }
  },

  _setupRoutes() {
    if (this._routeReady) return;

    const moduleName = "MMM-PhotoRoll";
    this.expressApp.get(new RegExp(`^/${moduleName}/\\d+/(.+)`), async (req, res) => {

      try {
        const rel = req.params[0] || "";

        const safeAbs = this._safeResolve(this.config.folder, rel);
        if (!safeAbs) return res.status(403).send("Forbidden");

        const stat = await fs.promises.stat(safeAbs).catch(() => null);
        if (!stat || !stat.isFile()) return res.status(404).send("Not found");

        const maxAge = Math.max(0, Number(this.config.cacheSeconds || 0));
        res.set("Cache-Control", `public, max-age=${maxAge}, immutable`);

        const wantsThumb = this.config.useThumbnails && (req.query.thumb === "1" || req.query.thumb === "true");
        if (wantsThumb && sharp) {
          const w = Math.max(64, Math.min(4096, Number(req.query.w || this.config.thumbnailMaxWidth || 1280)));
          res.type(path.extname(safeAbs));
          return sharp(safeAbs).rotate().resize({ width: w, withoutEnlargement: true }).toBuffer()
            .then(buf => res.end(buf))
            .catch(err => {
              console.error("[MMM-PhotoRoll] sharp error:", err.message);
              res.sendFile(safeAbs);
            });
        }

        return res.sendFile(safeAbs);
      } catch (e) {
        console.error("[MMM-PhotoRoll] serve error:", e);
        res.status(500).send("Server error");
      }
    });

    this._routeReady = true;
    console.log(`[MMM-PhotoRoll] HTTP route ready at /${moduleName}/:version/*`);
  },

  _safeResolve(root, rel) {
    const abs = path.resolve(root);
    const target = path.resolve(abs, rel || "");
    if (!target.startsWith(abs + path.sep) && target !== abs) return null;
    return target;
  },

  async _scanIfNeeded() {
    const now = Date.now();
    const minGap = Math.max(5000, Number(this.config.scanInterval || 3600000));
    if (now - this.lastScanTs < minGap && this.files.length) {
      this._pushList(false);
      return;
    }
    this.lastScanTs = now;

    try {
      const exts = new Set((this.config.allowedExtensions || []).map(e => e.toLowerCase()));
      const files = await this._walk(this.config.folder, !!this.config.recursive, exts);

      const sort = (this.config.sort || "name").toLowerCase();
      if (sort === "date") {
        files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      } else if (sort === "random") {
        files.sort((a, b) => {
          const ha = this._hash(a.rel + "|" + (a.mtime || 0));
          const hb = this._hash(b.rel + "|" + (b.mtime || 0));
          return ha - hb;
        });
      } else {
        files.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
      }

      this.files = files;
      this.version++;
      this._pushList(this.config.shuffle === true);
    } catch (e) {
      this.sendSocketNotification("PF_ERROR", e.message || String(e));
    }
  },

  async _walk(root, recursive, exts) {
    const out = [];
    const base = path.resolve(root);
    const stack = [""];
    while (stack.length) {
      const relDir = stack.pop();
      const absDir = this._safeResolve(base, relDir);
      if (!absDir) continue;
      let entries = [];
      try {
        entries = await fs.promises.readdir(absDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (ent.name.startsWith(".")) continue;
        const relPath = path.join(relDir, ent.name);
        const absPath = this._safeResolve(base, relPath);
        if (!absPath) continue;
        if (ent.isDirectory()) {
          if (recursive) stack.push(relPath);
          continue;
        }
        const ext = path.extname(ent.name).toLowerCase();
        if (!exts.size || exts.has(ext)) {
          let stat;
          try { stat = await fs.promises.stat(absPath); } catch { stat = null; }
          out.push({
            rel: relPath.replace(/\\/g, "/"),
            name: ent.name,
            mtime: stat ? Math.floor(stat.mtimeMs || 0) : 0
          });
        }
      }
      await new Promise(r => setImmediate(r));
    }
    return out;
  },

  _pushList(alreadyShuffled) {
    this.sendSocketNotification("PF_LIST", {
      version: this.version,
      files: this.files,
      shuffled: alreadyShuffled === true
    });
  },

  _hash(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return h >>> 0;
  }
});
