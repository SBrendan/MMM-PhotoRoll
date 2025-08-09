/* eslint-disable no-console */
const NodeHelper = require("node_helper");
const path = require("path");
const fs = require("fs");


module.exports = NodeHelper.create({
    start() {
        this.config = null;
        this.files = [];
        this.version = 0;
        this.lastScanTs = 0;
    },

    socketNotificationReceived(n, payload) {
        if (n === "PR_CONFIG") {
            if (!payload.folder) {
                payload.folder = path.join(__dirname, "uploads");
            }
            this.config = payload;
            this._setupRoutes();
        } else if (n === "PR_SCAN") {
            this._scanIfNeeded();
        }
    },

    _setupRoutes() {
        if (this._routeReady) return;
        const routerBase = "/MMM-PhotoRoll/:version";
        this.expressApp.get(`${routerBase}/*`, async (req, res) => {
            try {
                const rel = req.params[0];
                const safeAbs = this._safeResolve(this.config.folder, rel);
                if (!safeAbs) return res.status(403).send("Forbidden");
                const stat = await fs.promises.stat(safeAbs).catch(() => null);
                if (!stat || !stat.isFile()) return res.status(404).send("Not found");

                // Browser cache
                const maxAge = Math.max(0, Number(this.config.cacheSeconds || 0));
                res.set("Cache-Control", `public, max-age=${maxAge}, immutable`);

                return res.sendFile(safeAbs);
            } catch (e) {
                console.error("serve error:", e);
                res.status(500).send("Server error");
            }
        });
        this._routeReady = true;
        console.log("[MMM-PhotoRoll] HTTP Ready");
    },

    _safeResolve(root, rel) {
        const abs = path.resolve(root);
        const target = path.resolve(abs, rel || "");
        if (!target.startsWith(abs + path.sep) && target !== abs) {
            return null; // escape attempt
        }
        return target;
    },

    async _scanIfNeeded() {
        const now = Date.now();
        const minGap = Math.max(5000, Number(this.config.scanInterval || 3600000));
        if (now - this.lastScanTs < minGap && this.files.length) {
            // already scanned recently: send back the last list
            this._pushList(false);
            return;
        }
        this.lastScanTs = now;
        try {
            const exts = new Set((this.config.allowedExtensions || []).map(e => e.toLowerCase()));
            const files = await this._walk(this.config.folder, !!this.config.recursive, exts);
            // light sorting on the server side to spare the client
            const sort = (this.config.sort || "name").toLowerCase();
            if (sort === "date") {
                files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
            } else if (sort === "random") {
                // stable mix based on mtime+name (avoids rng at each boot)
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
            this._pushList(this.config.shuffle === true); // flag to indicate whether already “mixed”
        } catch (e) {
            this.sendSocketNotification("PR_ERROR", e.message || String(e));
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
        this.sendSocketNotification("PR_LIST", {
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
