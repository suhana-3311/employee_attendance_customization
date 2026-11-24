import { FilesetResolver, FaceLandmarker, HandLandmarker } from "/assets/employee_attendance_customization/vendor/mediapipe/vision_bundle.esm.js";

const ASSET_BASE = "/assets/employee_attendance_customization/vendor/mediapipe";
const USE_GPU = true;
const API = "/api/method/employee_attendance_customization.attendance.create_checkin_with_selfie";

// Capture tuning (same values as the HRMS screen)
const REQUIRED_GOOD_FRAMES = 3;
const MAX_BAD_FRAMES = 2;
const WARMUP_MS = 300;
const MIN_FACE_HEIGHT = 0.28;
const CIRCLE_RX = 0.34;
const CIRCLE_RY = 0.34 * (4 / 3);
const CIRCLE_TOLERANCE = 1.08;
const BURST_FRAMES = 3;
const SHARPNESS_GOOD = 55;
const SHARPNESS_MIN = 35;
const MAX_DRIFT = 10;
const HAND_COOLDOWN_MS = 800;
const SMALL_W = 64;
const SMALL_H = 48;

const DEFAULT_STATUS = "Fit your face inside the circle. We will automatically capture your selfie.";

const root = document.getElementById("sc");
let NEXT = "";
const CSRF = window.csrf_token || root.dataset.csrf || "";
const el = (id) => document.getElementById(id);
const stage = el("sc-stage");
const video = el("sc-video");
const statusEl = el("sc-status");
const previewImg = el("sc-preview");
const startBtn = el("sc-start");
const retakeBtn = el("sc-retake");
const submitBtn = el("sc-submit");
const doneBtn = el("sc-done");

// ---- UI helpers ----
function setStatus(message, state) {
  statusEl.textContent = message;
  statusEl.className = "sc-status" + (state ? " " + state : "");
}
function setHand(on) {
  stage.classList.toggle("sc-bad", !!on);
}
function ui(mode) {
  stage.hidden = mode !== "camera";
  previewImg.hidden = !(mode === "review" || mode === "busy");
  startBtn.hidden = mode !== "idle";
  retakeBtn.hidden = mode !== "review";
  submitBtn.hidden = !(mode === "review" || mode === "busy");
  doneBtn.hidden = mode !== "done";
  submitBtn.disabled = mode === "busy";
  retakeBtn.disabled = mode === "busy";
}

// ---- Detection models (loaded once, GPU then CPU fallback) ----
let detectorsPromise = null;

async function buildDetectors(vision, delegate) {
  const [face, hand] = await Promise.allSettled([
    FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: ASSET_BASE + "/models/face_landmarker.task", delegate: delegate },
      runningMode: "VIDEO",
      numFaces: 2,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
    HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: ASSET_BASE + "/models/hand_landmarker.task", delegate: delegate },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.3,
      minHandPresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
    }),
  ]);

  if (face.status === "fulfilled" && hand.status === "fulfilled") {
    return { face: face.value, hand: hand.value };
  }
  if (face.status === "fulfilled") face.value.close();
  if (hand.status === "fulfilled") hand.value.close();
  throw face.status === "rejected" ? face.reason : hand.reason;
}

async function createDetectors() {
  const vision = await FilesetResolver.forVisionTasks(ASSET_BASE + "/wasm");
  if (USE_GPU) {
    try {
      return await buildDetectors(vision, "GPU");
    } catch (error) {
      console.warn("GPU face detection unavailable, using CPU instead.", error);
    }
  }
  return buildDetectors(vision, "CPU");
}

function getDetectors() {
  if (!detectorsPromise) {
    detectorsPromise = createDetectors().catch((error) => {
      detectorsPromise = null;
      throw error;
    });
  }
  return detectorsPromise;
}

// ---- Detection loop state ----
let detectors = null;
let cameraStream = null;
let rafId = null;
let session = 0;
let isCapturing = false;
let goodFrames = 0;
let badFrames = 0;
let frameCount = 0;
let handSeen = false;
let lastVideoTime = -1;
let warmupUntil = 0;
let handBlockUntil = 0;
let lockFrame = null;
let lastTimestamp = 0;
let smallCanvas = null;
let selfieBlob = null;
let selfieUrl = "";

// ---- Helpers ----
function nextTimestamp() {
  lastTimestamp = Math.max(performance.now(), lastTimestamp + 1);
  return lastTimestamp;
}

function getSmallFrame(source) {
  if (!smallCanvas) {
    smallCanvas = document.createElement("canvas");
    smallCanvas.width = SMALL_W;
    smallCanvas.height = SMALL_H;
  }
  const context = smallCanvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0, SMALL_W, SMALL_H);
  const data = context.getImageData(0, 0, SMALL_W, SMALL_H).data;
  const gray = new Uint8Array(SMALL_W * SMALL_H);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return gray;
}

function frameChange(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// ---- Camera ----
async function startCamera() {
  stopCamera();
  const currentSession = ++session;

  setHand(false);
  ui("camera");

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    ui("idle");
    setStatus("Camera requires HTTPS or localhost.", "err");
    return;
  }

  setStatus("Starting camera...");
  const pending = getDetectors();
  pending.catch(function () {});

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "user" },
        width: { ideal: 1280 },
        height: { ideal: 960 },
        advanced: [{ focusMode: "continuous" }],
      },
    });

    if (currentSession !== session) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    cameraStream = stream;
    video.srcObject = stream;
    await video.play();
    if (video.videoWidth) {
      stage.style.aspectRatio = video.videoWidth + " / " + video.videoHeight;
    }

    const loaded = await pending;
    if (currentSession !== session) return;

    detectors = loaded;
    setStatus(DEFAULT_STATUS);
    warmupUntil = performance.now() + WARMUP_MS;
    detectLoop();
  } catch (error) {
    if (currentSession !== session) return;

    let message;
    if (error && error.name === "NotAllowedError") {
      message = "Camera permission was denied. Please allow camera access.";
    } else if (error && error.name === "NotFoundError") {
      message = "No camera was found on this device.";
    } else {
      message = (error && error.message) || "Unable to start camera or face detection. Please try again.";
    }
    stopCamera();
    ui("idle");
    setStatus(message, "err");
  }
}

function stopCamera() {
  session++;

  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  video.srcObject = null;

  detectors = null;
  goodFrames = 0;
  badFrames = 0;
  frameCount = 0;
  handSeen = false;
  lastVideoTime = -1;
  handBlockUntil = 0;
  lockFrame = null;
  isCapturing = false;
}

// ---- Face checks (normalized 0..1 coordinates) ----
function getFaceBox(points) {
  let left = 1, right = 0, top = 1, bottom = 0;
  for (const point of points) {
    if (point.x < left) left = point.x;
    if (point.x > right) right = point.x;
    if (point.y < top) top = point.y;
    if (point.y > bottom) bottom = point.y;
  }
  return { left: left, right: right, top: top, bottom: bottom };
}

function isFaceInsideCircle(box) {
  const rx = CIRCLE_RX * CIRCLE_TOLERANCE;
  const ry = CIRCLE_RY * CIRCLE_TOLERANCE;
  return [
    [box.left, box.top],
    [box.right, box.top],
    [box.left, box.bottom],
    [box.right, box.bottom],
  ].every(function (p) {
    return Math.pow((p[0] - 0.5) / rx, 2) + Math.pow((p[1] - 0.5) / ry, 2) <= 1;
  });
}

function areEyesOpen(points) {
  const leftWidth = Math.hypot(points[33].x - points[133].x, points[33].y - points[133].y);
  const leftHeight = Math.hypot(points[159].x - points[145].x, points[159].y - points[145].y);
  const rightWidth = Math.hypot(points[362].x - points[263].x, points[362].y - points[263].y);
  const rightHeight = Math.hypot(points[386].x - points[374].x, points[386].y - points[374].y);
  if (!leftWidth || !rightWidth) return false;
  return leftHeight / leftWidth > 0.1 && rightHeight / rightWidth > 0.1;
}

function isFacingCamera(points) {
  const leftEye = points[33];
  const rightEye = points[263];
  const nose = points[1];
  const eyeCenterX = (leftEye.x + rightEye.x) / 2;
  const eyeWidth = Math.abs(rightEye.x - leftEye.x);
  if (!eyeWidth) return false;
  const yawDeviation = Math.abs(nose.x - eyeCenterX) / eyeWidth;
  const tilt = Math.abs(Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x) * (180 / Math.PI));
  return yawDeviation < 0.25 && tilt < 15;
}

function getSharpness(context, width, height) {
  const pixels = context.getImageData(0, 0, width, height).data;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    gray[i] = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
  }
  let sum = 0, sumSquared = 0, count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const laplacian = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += laplacian;
      sumSquared += laplacian * laplacian;
      count++;
    }
  }
  if (!count) return 0;
  const mean = sum / count;
  return sumSquared / count - mean * mean;
}

// ---- Detection loop (same rules for Check In and Check Out) ----
function rejectFrame(message, handDetected, forceReset) {
  badFrames++;
  if (handDetected || forceReset || badFrames >= MAX_BAD_FRAMES) {
    goodFrames = 0;
    lockFrame = null;
  }
  setHand(handDetected);
  setStatus(message);
}

function evaluateFrame() {
  const small = getSmallFrame(video);
  const faces = detectors.face.detectForVideo(video, nextTimestamp()).faceLandmarks || [];

  // Strict rule: any hand anywhere in the frame blocks capture.
  frameCount++;
  if (goodFrames > 0 || frameCount % 2 === 1) {
    handSeen = (detectors.hand.detectForVideo(video, nextTimestamp()).landmarks || []).length > 0;
    if (handSeen) handBlockUntil = performance.now() + HAND_COOLDOWN_MS;
  }

  if (handSeen || performance.now() < handBlockUntil) {
    return rejectFrame("Remove your hand or fingers from the camera.", true, false);
  }
  if (faces.length === 0) return rejectFrame(DEFAULT_STATUS, false, false);
  if (faces.length > 1) return rejectFrame("Multiple faces detected. Only one person is allowed.", false, false);

  const points = faces[0];
  const box = getFaceBox(points);

  if (!isFaceInsideCircle(box)) return rejectFrame("Move your complete face inside the circle.", false, false);
  if (box.bottom - box.top < MIN_FACE_HEIGHT) return rejectFrame("Move closer to the camera.", false, false);
  if (!areEyesOpen(points)) return rejectFrame("Keep both eyes open and visible.", false, false);
  if (!isFacingCamera(points)) return rejectFrame("Look directly at the camera. Keep your head straight.", false, false);

  if (goodFrames === 0 || !lockFrame) {
    lockFrame = small;
  } else if (frameChange(lockFrame, small) > MAX_DRIFT) {
    return rejectFrame("Hold still. Something is moving in front of the camera.", false, true);
  }

  badFrames = 0;
  setHand(false);
  setStatus(DEFAULT_STATUS);
  goodFrames++;

  if (goodFrames >= REQUIRED_GOOD_FRAMES) {
    isCapturing = true;
    setStatus("Capturing your selfie...");
    captureSelfie();
  }
}

function detectLoop() {
  if (!detectors || selfieBlob || isCapturing) return;

  const now = performance.now();
  if (now >= warmupUntil && video.readyState >= 2 && video.videoWidth && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      evaluateFrame();
    } catch (error) {
      goodFrames = 0;
      setStatus("Face detection error. Please try again.");
    }
    if (isCapturing) return;
  }
  rafId = requestAnimationFrame(detectLoop);
}

// ---- Capture ----
function grabFrame(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.videoWidth;
  canvas.height = source.videoHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas: canvas, sharpness: getSharpness(context, canvas.width, canvas.height) };
}

function resumeDetection(message, handDetected) {
  isCapturing = false;
  goodFrames = 0;
  badFrames = 0;
  lockFrame = null;
  setHand(handDetected);
  setStatus(message);
  detectLoop();
}

// Final check on the exact picture that is about to be saved
function verifyCapturedFrame(canvas) {
  if (!detectors) return null;
  try {
    if ((detectors.hand.detectForVideo(canvas, nextTimestamp()).landmarks || []).length) {
      handBlockUntil = performance.now() + HAND_COOLDOWN_MS;
      return { message: "Remove your hand or fingers from the camera.", hand: true };
    }
    const faces = detectors.face.detectForVideo(canvas, nextTimestamp()).faceLandmarks || [];
    if (faces.length !== 1 || !isFaceInsideCircle(getFaceBox(faces[0]))) {
      return { message: "Move your complete face inside the circle.", hand: false };
    }
    if (lockFrame && frameChange(lockFrame, getSmallFrame(canvas)) > MAX_DRIFT) {
      return { message: "Hold still. Something is moving in front of the camera.", hand: false };
    }
  } catch (error) {
    // Never block a check-in because the extra verification itself failed
    return null;
  }
  return null;
}

async function captureSelfie() {
  let best = null;

  for (let attempt = 0; attempt < BURST_FRAMES; attempt++) {
    if (!video.videoWidth || !cameraStream) break;
    const frame = grabFrame(video);
    if (frame && (!best || frame.sharpness > best.sharpness)) best = frame;
    if (best && best.sharpness >= SHARPNESS_GOOD) break;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  if (!cameraStream) return;

  if (!best || best.sharpness < SHARPNESS_MIN) {
    resumeDetection("Image is blurry. Hold still and look at the camera.", false);
    return;
  }

  const problem = verifyCapturedFrame(best.canvas);
  if (problem) {
    resumeDetection(problem.message, problem.hand);
    return;
  }

  const blob = await new Promise((resolve) => best.canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!cameraStream) return;

  if (!blob) {
    resumeDetection("Unable to capture selfie.", false);
    return;
  }

  clearSelfie();
  selfieBlob = blob;
  selfieUrl = URL.createObjectURL(blob);
  previewImg.src = selfieUrl;

  stopCamera();
  ui("review");
  setHand(false);
  setStatus("Selfie captured. Check it, then submit.", "ok");
}

function clearSelfie() {
  if (selfieUrl) URL.revokeObjectURL(selfieUrl);
  selfieUrl = "";
  selfieBlob = null;
  previewImg.removeAttribute("src");
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Unable to read selfie image."));
    reader.readAsDataURL(blob);
  });
}

// ---- Submit ----
function serverMessages(data) {
  try {
    if (data && data._server_messages) {
      return JSON.parse(data._server_messages).map(function (m) {
        return String(JSON.parse(m).message).replace(/<[^>]*>/g, "");
      });
    }
  } catch (e) {}
  return [];
}

async function submitSelfie() {
  if (!selfieBlob) return;
  ui("busy");
  setStatus("Submitting...");

  try {
    const base64 = await blobToBase64(selfieBlob);
    const response = await fetch(API, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Frappe-CSRF-Token": CSRF,
      },
      body: JSON.stringify({ selfie_base64: base64, log_type: NEXT }),
    });
    const data = await response.json().catch(function () { return {}; });

    if (response.ok && data.message && data.message.name) {
      clearSelfie();
      ui("done");
      setStatus(data.message.log_type === "OUT" ? "Check Out successful!" : "Check In successful!", "ok");
      return;
    }

    const messages = serverMessages(data);
    ui("review");
    setStatus(messages.length ? messages.join(" ") : "Check In failed. Please try again.", "err");
  } catch (error) {
    ui("review");
    setStatus("Network error. Please try again.", "err");
  }
}

// ---- Wiring ----
startBtn.addEventListener("click", startCamera);
retakeBtn.addEventListener("click", function () {
  clearSelfie();
  startCamera();
});
submitBtn.addEventListener("click", submitSelfie);
doneBtn.addEventListener("click", function () { location.reload(); });
window.addEventListener("pagehide", stopCamera);

ui("idle");
setStatus("");
setTimeout(function () { getDetectors().catch(function () {}); }, 1000);

// ---- Load employee name and next action ----
async function loadState() {
  startBtn.disabled = true;
  try {
    const response = await fetch(
      "/api/method/employee_attendance_customization.attendance.get_checkin_state",
      { credentials: "same-origin", headers: { "Accept": "application/json" } }
    );
    const data = await response.json().catch(function () { return {}; });

    if (response.ok && data.message) {
      NEXT = data.message.next_action;
      el("sc-title").textContent = NEXT === "OUT" ? "Check Out" : "Check In";
      el("sc-name").textContent = data.message.employee_name || "";
      startBtn.disabled = false;
      return;
    }

    const messages = serverMessages(data);
    setStatus(messages.length ? messages.join(" ") : "Could not load your check-in status. Please log in again.", "err");
  } catch (error) {
    setStatus("Network error. Please reload the page.", "err");
  }
}
loadState();
