package com.medsource.gamoterp.posface

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.util.Log
import android.util.Size
import androidx.annotation.OptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.lifecycle.awaitInstance
import androidx.camera.view.PreviewView
import androidx.lifecycle.LifecycleOwner
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetector
import com.google.mlkit.vision.face.FaceDetectorOptions
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

private const val TAG = "PosFace"
private const val MIN_EMIT_INTERVAL_MS = 50L // ≤ 20 face events per second (a blink lasts 100–300 ms)
private const val MIN_JPEG_QUALITY = 40

/**
 * Front-camera preview (mirrored, like a mirror) + an ImageAnalysis stream at ~640×480 that ML Kit face detection runs
 * on (FAST mode, eye-open classification, head Euler angles). Each result goes to JS as `onFaces`; JS decides the
 * challenge. `captureFrame` saves the NEXT analysed frame — so the photo is what the detector saw at that moment —
 * upright but un-mirrored (the server's yaw checks assume the raw camera image), as a JPEG under filesDir.
 *
 * Head yaw (ML Kit `headEulerAngleY`): positive = the face turned toward the CAMERA's right = the person's OWN LEFT
 * (contract: TURN_LEFT). The sign is applied in JS (src/attendance/liveness.ts) so it can be corrected in one place.
 */
@SuppressLint("ViewConstructor")
class PosFaceCameraView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onFaces by EventDispatcher()
  private val onCameraReady by EventDispatcher()
  private val onCameraError by EventDispatcher()

  // RN doesn't lay out native children; let Android measure the preview (its TextureView is added later).
  override val shouldUseAndroidLayout: Boolean = true

  private val previewView = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }

  private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
  private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val detector: FaceDetector = FaceDetection.getClient(
    FaceDetectorOptions.Builder()
      .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
      .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
      .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_NONE)
      .setContourMode(FaceDetectorOptions.CONTOUR_MODE_NONE)
      .setMinFaceSize(0.15f)
      .build()
  )

  private var cameraProvider: ProcessCameraProvider? = null
  private var preview: Preview? = null
  private var analysis: ImageAnalysis? = null
  private var active = false
  private var starting = false
  private var destroyed = false
  @Volatile private var lastEmitAt = 0L

  private class CaptureRequest(val maxSide: Int, val quality: Int, val maxBytes: Int, val promise: Promise)

  @Volatile private var pendingCapture: CaptureRequest? = null

  init {
    addView(previewView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val w = r - l
    val h = b - t
    previewView.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    previewView.layout(0, 0, w, h)
  }

  fun setActive(value: Boolean) {
    if (active == value) return
    active = value
    if (value) startCamera() else stopCamera()
  }

  fun requestCapture(maxSide: Int, quality: Int, maxBytes: Int, promise: Promise) {
    if (analysis == null) {
      promise.reject("E_NOT_RUNNING", "The camera is not running", null)
      return
    }
    // A newer request replaces an unanswered one (the old one is told so).
    pendingCapture?.promise?.reject("E_REPLACED", "Another photo was requested", null)
    pendingCapture = CaptureRequest(maxSide.coerceIn(64, 4096), quality.coerceIn(MIN_JPEG_QUALITY, 100), maxBytes.coerceAtLeast(8 * 1024), promise)
  }

  fun destroy() {
    destroyed = true
    stopCamera()
    scope.cancel()
    try {
      detector.close()
    } catch (_: Exception) {
    }
    analysisExecutor.shutdown()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    stopCamera()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (active && analysis == null) startCamera()
  }

  private fun emitError(code: String, message: String) {
    onCameraError(mapOf("code" to code, "message" to message))
  }

  private fun startCamera() {
    if (destroyed || starting || analysis != null) return
    val owner = appContext.currentActivity as? LifecycleOwner
    if (owner == null) {
      emitError("NO_ACTIVITY", "The camera can't start right now")
      return
    }
    starting = true
    scope.launch {
      try {
        val provider = ProcessCameraProvider.awaitInstance(context)
        cameraProvider = provider
        if (!active || destroyed || analysis != null) return@launch
        if (!provider.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA)) {
          emitError("NO_CAMERA", "This tablet has no front camera")
          return@launch
        }
        val newPreview = Preview.Builder().build()
        newPreview.setSurfaceProvider(previewView.surfaceProvider)
        val newAnalysis = ImageAnalysis.Builder()
          .setResolutionSelector(
            ResolutionSelector.Builder()
              .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
              .setResolutionStrategy(ResolutionStrategy(Size(640, 480), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
              .build()
          )
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
          .build()
        newAnalysis.setAnalyzer(analysisExecutor) { image -> analyze(image) }
        provider.bindToLifecycle(owner, CameraSelector.DEFAULT_FRONT_CAMERA, newPreview, newAnalysis)
        preview = newPreview
        analysis = newAnalysis
        onCameraReady(mapOf())
      } catch (e: Exception) {
        Log.w(TAG, "camera start failed", e)
        emitError("START_FAILED", "The camera could not be started: ${e.message ?: e.javaClass.simpleName}")
      } finally {
        starting = false
      }
    }
  }

  private fun stopCamera() {
    val provider = cameraProvider
    val p = preview
    val a = analysis
    preview = null
    analysis = null
    a?.clearAnalyzer()
    try {
      if (provider != null) {
        if (p != null) provider.unbind(p)
        if (a != null) provider.unbind(a)
      }
    } catch (e: Exception) {
      Log.w(TAG, "camera unbind failed", e)
    }
    pendingCapture?.promise?.reject("E_STOPPED", "The camera was stopped", null)
    pendingCapture = null
  }

  @OptIn(ExperimentalGetImage::class)
  private fun analyze(image: ImageProxy) {
    val media = image.image
    if (media == null) {
      image.close()
      return
    }
    val rotation = image.imageInfo.rotationDegrees
    val capture = pendingCapture
    if (capture != null) {
      pendingCapture = null
      try {
        capture.promise.resolve(saveFrame(image, rotation, capture))
      } catch (e: Exception) {
        Log.w(TAG, "frame capture failed", e)
        capture.promise.reject("E_CAPTURE", "The photo could not be saved: ${e.message ?: e.javaClass.simpleName}", e)
      }
    }
    val uprightW = if (rotation % 180 == 0) image.width else image.height
    val uprightH = if (rotation % 180 == 0) image.height else image.width
    val input = InputImage.fromMediaImage(media, rotation)
    detector.process(input)
      .addOnSuccessListener { faces -> emitFaces(faces, uprightW, uprightH) }
      .addOnFailureListener { e -> Log.w(TAG, "face detection failed", e) }
      .addOnCompleteListener { image.close() }
  }

  private fun emitFaces(faces: List<Face>, w: Int, h: Int) {
    val now = System.currentTimeMillis()
    if (now - lastEmitAt < MIN_EMIT_INTERVAL_MS || !active) return
    lastEmitAt = now
    val fw = w.toDouble().coerceAtLeast(1.0)
    val fh = h.toDouble().coerceAtLeast(1.0)
    val list = faces.map { f ->
      val box = f.boundingBox
      mapOf(
        "yaw" to f.headEulerAngleY.toDouble(),
        "pitch" to f.headEulerAngleX.toDouble(),
        "roll" to f.headEulerAngleZ.toDouble(),
        "leftEyeOpen" to (f.leftEyeOpenProbability?.toDouble() ?: -1.0),
        "rightEyeOpen" to (f.rightEyeOpenProbability?.toDouble() ?: -1.0),
        "x" to box.left / fw,
        "y" to box.top / fh,
        "width" to box.width() / fw,
        "height" to box.height() / fh,
        "trackingId" to (f.trackingId ?: -1),
      )
    }
    onFaces(mapOf("faces" to list, "frameWidth" to w, "frameHeight" to h, "timestamp" to now.toDouble()))
  }

  /** The frame as an upright, un-mirrored JPEG file ≤ maxSide px and ≤ maxBytes (quality lowered in steps of 10). */
  private fun saveFrame(image: ImageProxy, rotation: Int, req: CaptureRequest): Map<String, Any> {
    val raw = image.toBitmap()
    val longest = max(raw.width, raw.height)
    val scale = if (longest > req.maxSide) req.maxSide.toFloat() / longest else 1f
    val matrix = Matrix()
    if (rotation != 0) matrix.postRotate(rotation.toFloat())
    if (scale < 1f) matrix.postScale(scale, scale)
    val upright = if (rotation == 0 && scale >= 1f) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
    var quality = req.quality
    var bytes: ByteArray
    while (true) {
      val out = ByteArrayOutputStream()
      upright.compress(Bitmap.CompressFormat.JPEG, quality, out)
      bytes = out.toByteArray()
      if (bytes.size <= req.maxBytes || quality <= MIN_JPEG_QUALITY) break
      quality = max(MIN_JPEG_QUALITY, quality - 10)
    }
    val width = upright.width
    val height = upright.height
    if (upright !== raw) upright.recycle()
    raw.recycle()
    if (bytes.size > req.maxBytes) throw IllegalStateException("the photo is larger than ${req.maxBytes} bytes")

    val dir = framesDir(context)
    if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("the photo folder can't be created")
    val name = "${UUID.randomUUID()}.jpg"
    val tmp = File(dir, "$name.tmp")
    FileOutputStream(tmp).use { fos ->
      fos.write(bytes)
      fos.fd.sync() // durable before JS records the punch that lists it
    }
    val file = File(dir, name)
    if (!tmp.renameTo(file)) throw IllegalStateException("the photo could not be saved")
    val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    return mapOf(
      "path" to file.absolutePath,
      "uri" to "file://${file.absolutePath}",
      "width" to width,
      "height" to height,
      "bytes" to bytes.size,
      "sha256" to sha,
    )
  }
}
