self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([caches.delete('book-covers'), caches.delete('book-thumbnails')]))
})
