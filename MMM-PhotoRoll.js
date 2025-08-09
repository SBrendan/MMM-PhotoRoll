Module.register("MMM-PhotoRoll", {
    defaults: {
        folder: "uploads", // file source
        recursive: true,
        allowedExtensions: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
        sort: "name",            // "name" | "date" | "random"
        scanInterval: 60 * 60 * 1000, // 1 hour: rescan the disk (I/O savings)
        updateInterval: 15 * 1000, // 15s: change photo
        shuffle: false,          // if true, mixes the list on the client side
        showCaptions: false,     // displays the file name
        maxWidth: "100%",        // CSS
        maxHeight: "100%",       // CSS
        fadeSeconds: 0.8,        // fade CSS
        brightness: 1.0,         // 0.0–1.0 (filter CSS)
        rotateDegrees: 0,        // 0 | 90 | 180 | 270 (CSS only)
        cacheSeconds: 24 * 3600  // HTTP cache for images on the browser side
    },

    start() {
        this.images = [];
        this.index = 0;
        this.nextImg = null;
        this.loaded = false;
        this.lastListVersion = 0;
        this.scheduleNext = null;

        this.sendSocketNotification("PR_CONFIG", this.config);
        this.scanTimer = setInterval(() => {
            this.sendSocketNotification("PR_SCAN");
        }, Math.max(10 * 1000, this.config.scanInterval));
    },

    getStyles() {
        return ["MMM-PhotoRoll.css"];
    },

    getDom() {
        const wrapper = document.createElement("div");
        wrapper.className = "pr-wrapper";

        if (!this.loaded) {
            wrapper.innerHTML = "<div class='pr-status'>Chargement…</div>";
            return wrapper;
        }
        if (!this.images.length) {
            wrapper.innerHTML = "<div class='pr-status'>Aucune image</div>";
            return wrapper;
        }

        const current = this.images[this.index % this.images.length];
        const url = this._imageUrl(current);

        const stage = document.createElement("div");
        stage.className = "pr-stage";
        stage.style.maxWidth = this.config.maxWidth || "100%";
        stage.style.maxHeight = this.config.maxHeight || "100%";
        if (this.config.minWidth)  stage.style.minWidth  = this.config.minWidth;
        if (this.config.minHeight) stage.style.minHeight = this.config.minHeight;
        wrapper.appendChild(stage);

        const bg = document.createElement("img");
        bg.className = "pr-bg";
        bg.src = url;
        bg.decoding = "async";
        bg.loading = "lazy";
        bg.alt = "";
        wrapper.appendChild(bg);

        const img = document.createElement("img");
        img.className = "pr-image";
        img.src = url;
        img.loading = "lazy";
        img.decoding = "async";
        img.style.maxWidth = this.config.maxWidth;
        img.style.maxHeight = this.config.maxHeight;
        img.style.filter = `brightness(${this.config.brightness})`;
        img.style.transform = `rotate(${this.config.rotateDegrees}deg)`;
        img.style.setProperty("--pr-fade-seconds", String(this.config.fadeSeconds));
        wrapper.appendChild(img);

        if (this.config.showCaptions) {
            const cap = document.createElement("div");
            cap.className = "pr-caption";
            cap.textContent = current.name || "";
            wrapper.appendChild(cap);
        }

        this._preloadNext();
        this._schedule();

        return wrapper;
    },

    _schedule() {
        if (this.scheduleNext) clearTimeout(this.scheduleNext);
        this.scheduleNext = setTimeout(() => {
            this.index = (this.index + 1) % Math.max(1, this.images.length);
            this.updateDom(250);
        }, this.config.updateInterval);
    },

    _preloadNext() {
        if (!this.images.length) return;
        const nextIndex = (this.index + 1) % this.images.length;
        const next = this.images[nextIndex];
        const url = this._imageUrl(next);
        if (this.nextImg && this.nextImg.src === url) return;
        this.nextImg = new Image();
        this.nextImg.loading = "eager";
        this.nextImg.src = url;
    },

    _imageUrl(item) {
        const base = `/MMM-PhotoRoll/${encodeURIComponent(String(this.lastListVersion))}`;
        const q = [];
        q.push(`t=${encodeURIComponent(item.mtime || 0)}`);
        const qs = q.length ? `?${q.join("&")}` : "";
        return `${base}/${encodeURIComponent(item.rel)}` + qs;
    },

    socketNotificationReceived(n, payload) {
        if (n === "PR_LIST") {
            this.lastListVersion = payload.version || 0;
            this.images = payload.files || [];
            if (this.config.shuffle && !payload.shuffled) {
                for (let i = this.images.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [this.images[i], this.images[j]] = [this.images[j], this.images[i]];
                }
            }
            this.index = Math.min(this.index, Math.max(0, this.images.length - 1));
            this.loaded = true;
            this.updateDom(0);
        } else if (n === "PR_LOG") {
            Log.log(`[MMM-PhotoRoll] ${payload}`);
        } else if (n === "PR_ERROR") {
            Log.error(`[MMM-PhotoRoll] ${payload}`);
        }
    },

    notificationReceived(notification) {
        if (notification === "MODULE_DOM_CREATED") {
            this.sendSocketNotification("PR_SCAN");
        }
    }
});
