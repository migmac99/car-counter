/** Webcam and video-file sources for the <video> element. */

export async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

/**
 * Open the webcam into the video element. Returns the MediaStream.
 * Must be called from a secure context (localhost or HTTPS).
 */
export async function openCamera(video, deviceId) {
  const constraints = {
    audio: false,
    video: {
      // Ask for 1080p so digital zoom still has real pixels to crop into.
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }),
    },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  await video.play();
  return stream;
}

/** Play a local video file (useful for testing with recorded traffic). */
export async function openFile(video, file) {
  stopSource(video);
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  video.loop = true;
  await video.play();
}

export function stopSource(video) {
  if (video.srcObject) {
    for (const t of video.srcObject.getTracks()) t.stop();
    video.srcObject = null;
  }
  if (video.src) {
    URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }
}
