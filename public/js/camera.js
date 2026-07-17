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
      // 1080p so digital zoom has real pixels; 30 fps so fast traffic gets
      // enough samples per crossing (cameras may silently deliver less in
      // low light — the perf chip surfaces what was actually achieved).
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
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

/** Actual settings the camera granted (null for file sources). */
export function cameraSettings(video) {
  const track = video.srcObject?.getVideoTracks?.()[0];
  if (!track) return null;
  const s = track.getSettings();
  return { width: s.width, height: s.height, frameRate: s.frameRate };
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
