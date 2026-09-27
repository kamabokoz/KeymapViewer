// Decodes QR codes from camera frames off the main thread.
importScripts('../vendor/jsQR.js');

self.onmessage = (e) => {
  const { data, width, height } = e.data;
  const px = new Uint8ClampedArray(data);
  const r = self.jsQR(px, width, height, { inversionAttempts: 'dontInvert' });
  self.postMessage(r && r.data ? r.data : null);
};
