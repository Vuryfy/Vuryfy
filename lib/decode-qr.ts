import jsQR from "jsqr";

// Client-side QR decode — deterministic-tool-first per Part 11 ("QR
// decoding... use deterministic/dedicated tools first; AI is only invoked
// on the extracted output, never to 'read' what a deterministic tool can
// already extract"). This runs entirely in the browser via jsQR + canvas:
// the photo never leaves the device, so there's no upload, no storage, and
// none of Part 15's media-retention questions apply to this input type —
// only the decoded text (a URL or plain string) is ever sent to the
// server, exactly like a manually-typed claim.
//
// Downscales to a max dimension before decoding — phone camera photos can
// be 4000px+ on a side, and jsQR's decode time scales with pixel count. A
// QR code's contrast survives a canvas-quality downscale fine for a code
// that fills a reasonable fraction of the frame, so this is a real speed
// win with no meaningful accuracy cost in the common case.
const MAX_DIMENSION = 1000;

export async function decodeQrFromFile(file: File): Promise<string | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await loadImage(objectUrl);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);

    const imageData = ctx.getImageData(0, 0, width, height);
    const code = jsQR(imageData.data, imageData.width, imageData.height);
    return code?.data ?? null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't load that image."));
    img.src = src;
  });
}
