
const CACHE_NAME = "dartvexo-v4";

const APP_FILES = [
    "./",
    "./index.html",
    "./style.css",
    "./script.js",
    "./manifest.json",
    "./icons/icon-192.png",
    "./icons/icon-512.png"
];

// App-Dateien beim Installieren speichern
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(APP_FILES);
        })
    );

    self.skipWaiting();
});

// Alte DartForge- und DartVexo-Caches entfernen
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => {
                        const lowerName = name.toLowerCase();

                        return (
                            (lowerName.startsWith("dartforge-") ||
                             lowerName.startsWith("dartvexo-")) &&
                            name !== CACHE_NAME
                        );
                    })
                    .map((name) => caches.delete(name))
            );
        }).then(() => {
            return self.clients.claim();
        })
    );
});

// Dateien laden und aktualisieren
self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") {
        return;
    }

    const url = new URL(event.request.url);

    // Nur Dateien der eigenen Website behandeln
    if (url.origin !== self.location.origin) {
        return;
    }

    // HTML-Seiten: zuerst online versuchen
    if (event.request.mode === "navigate") {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response && response.ok) {
                        const responseCopy = response.clone();

                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put("./index.html", responseCopy);
                        });
                    }

                    return response;
                })
                .catch(() => {
                    return caches.match("./index.html");
                })
        );

        return;
    }

    // Andere Dateien: online laden und Cache aktualisieren
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response && response.ok) {
                    const responseCopy = response.clone();

                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseCopy);
                    });
                }

                return response;
            })
            .catch(() => {
                return caches.match(event.request).then((cached) => {
                    if (cached) {
                        return cached;
                    }

                    return new Response("Offline nicht verfügbar", {
                        status: 503,
                        statusText: "Service Unavailable"
                    });
                });
            })
    );
});
