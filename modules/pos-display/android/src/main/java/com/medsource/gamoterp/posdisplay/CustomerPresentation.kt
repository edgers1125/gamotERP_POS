package com.medsource.gamoterp.posdisplay

import android.app.Activity
import android.app.Presentation
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.facebook.react.common.assets.ReactFontManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

// What the customer sees (plain Android views, built in code), all on the brand's own colours — flat, no gradients:
//   * Cart     — LEFT half: the brand on the BACKDROP (MedSource deep blue #033f74 for the standard brand, else the
//                brand's primary): the logo with a thin white contour tracing its shape (see outlinedLogo — no white
//                card behind it), the name below in ivory, an accent-colour bar (MedSource green #7ab537), and a thin
//                accent strip down the pane's inner edge; with no logo the name alone, vertically centred.
//                RIGHT half: a darker PANEL (the backdrop 30% towards black) with the order lines in ivory, the totals,
//                and a "due" box (backdrop colour) holding the large grand total in the accent + cash received / change.
//   * ThankYou — same split; the right half shows the thank-you message and the figures JS sent (paid / change in
//                the accent).
//   * Idle     — the branch's ads full-screen, each for its duration; with no (decodable) ads, the brand full-screen
//                (same backdrop, the accent strip along the bottom instead).
// Contrast is guaranteed here whatever brand colours arrive: the backdrop is darkened until ivory text on it reaches
// 7:1; muted text and the accent (as text) are lightened towards ivory until they reach 4.5:1 on what they sit on
// (WCAG AA); the accent bar / strips reach 3:1 (non-text).
// Every string (money included) arrives already formatted from JS — nothing is computed here. Sizes scale with the
// display's height so it reads from 1–2 m away on any monitor.

private const val TAG = "PosDisplay"

internal class CustomerPresentation(outer: Activity, display: Display) : Presentation(outer, display) {
  private val main = Handler(Looper.getMainLooper())
  private val decoder: ExecutorService = Executors.newSingleThreadExecutor()

  private var config: DisplayConfig = DisplayConfig.DEFAULT
  private var current: DisplayScreen = DisplayScreen.Idle
  private var logoBitmap: Bitmap? = null
  /** Path + size + mtime of the logo file last decoded — a changed file reloads even at the same path. */
  private var logoKeyLoaded: String? = null
  private var logoGeneration = 0
  /** Outlined renders of the current logo, per "w×h×stroke" (the split and the full-screen size — at most two). */
  private val outlinedLogos = HashMap<String, Bitmap>()
  /** The outlined render the ImageView should show right now (a build finishing late for another size is ignored). */
  private var wantedOutlineKey: String? = null
  private var adIndex = 0
  private var adGeneration = 0
  private var adsPlaying = false
  private var released = false

  private lateinit var root: FrameLayout
  private lateinit var split: LinearLayout
  /** The brand's slot in the split: the backdrop pane plus the accent strip (inner edge in the split, bottom full-screen). */
  private lateinit var brandHost: FrameLayout
  private lateinit var brandPane: LinearLayout
  private lateinit var brandBandSide: View
  private lateinit var brandBandBottom: View
  private lateinit var brandLogo: ImageView
  /** Width of the brand pane right now: half the screen in the split, all of it when the brand is full-screen. */
  private var brandPaneFullWidth = false
  private lateinit var brandName: TextView
  private lateinit var brandAccent: View
  private lateinit var rightPane: FrameLayout
  private lateinit var cartPane: LinearLayout
  private lateinit var greeting: TextView
  private lateinit var heading: TextView
  private lateinit var linesScroll: ScrollView
  private lateinit var linesBox: LinearLayout
  private lateinit var totalsBox: LinearLayout
  private lateinit var dueBox: LinearLayout
  private lateinit var grandLabel: TextView
  private lateinit var grandValue: TextView
  private lateinit var paymentBox: LinearLayout
  private lateinit var thanksPane: LinearLayout
  private lateinit var thanksTitle: TextView
  private lateinit var thanksSubtitle: TextView
  private lateinit var thanksRows: LinearLayout
  private lateinit var adImage: ImageView

  private var built = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window?.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    build()
    built = true
    applyConfig()
    applyScreen()
  }

  override fun onStop() {
    stopAds()
    super.onStop()
  }

  /** Stops timers and the decoder thread; the Presentation is dismissed right after. */
  fun release() {
    released = true
    stopAds()
    decoder.shutdownNow()
  }

  fun setConfig(next: DisplayConfig) {
    config = next
    if (built) {
      applyConfig()
      applyScreen()
    }
  }

  fun render(screen: DisplayScreen) {
    current = screen
    if (built) applyScreen()
  }

  // ---- sizes / colours / fonts -----------------------------------------------------------------------------------

  private val screenH: Float get() = display.let { d ->
    val m = android.util.DisplayMetrics()
    @Suppress("DEPRECATION")
    d.getRealMetrics(m)
    m.heightPixels.toFloat().coerceAtLeast(480f)
  }
  private val screenW: Float get() = display.let { d ->
    val m = android.util.DisplayMetrics()
    @Suppress("DEPRECATION")
    d.getRealMetrics(m)
    m.widthPixels.toFloat().coerceAtLeast(640f)
  }

  private fun px(fractionOfHeight: Float): Int = (screenH * fractionOfHeight).toInt()

  private fun color(value: String?, fallback: String): Int = try {
    Color.parseColor(if (value.isNullOrBlank()) fallback else value)
  } catch (e: IllegalArgumentException) {
    Color.parseColor(fallback)
  }

  private fun paletteColor(key: String, fallback: String) = color(config.palette[key], fallback)

  // WCAG relative luminance / contrast ratio.
  private fun luminance(c: Int): Double {
    fun ch(v: Int): Double {
      val s = v / 255.0
      return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * ch(Color.red(c)) + 0.7152 * ch(Color.green(c)) + 0.0722 * ch(Color.blue(c))
  }
  private fun contrast(a: Int, b: Int): Double {
    val la = luminance(a)
    val lb = luminance(b)
    return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
  }
  /** [amount] (0..1) of [b] mixed into [a] — flat colour maths only. */
  private fun mix(a: Int, b: Int, amount: Float): Int {
    fun ch(x: Int, y: Int) = (x + (y - x) * amount).roundToInt().coerceIn(0, 255)
    return Color.rgb(ch(Color.red(a), Color.red(b)), ch(Color.green(a), Color.green(b)), ch(Color.blue(a), Color.blue(b)))
  }
  /** [c] moved step by step towards [target] until it reaches [ratio] against [bg] (unchanged if it already does). */
  private fun toContrast(c: Int, target: Int, bg: Int, ratio: Double): Int {
    var out = c
    var f = 0f
    while (contrast(out, bg) < ratio && f < 1f) {
      f += 0.05f
      out = mix(c, target, f)
    }
    return out
  }

  /** Text colour on every dark surface: the app's ivory (#fffdf8). */
  private val ivory get() = paletteColor("background", "#fffdf8")
  /** The display's backdrop (MedSource deep blue for the standard brand), darkened if needed so ivory text reads at 7:1. */
  private val backdrop get() = toContrast(paletteColor("displayBackground", "#033f74"), Color.BLACK, ivory, 7.0)
  /** The order / thank-you panel: the backdrop 30% towards black — a subtle, solid step darker. */
  private val panel get() = mix(backdrop, Color.BLACK, 0.3f)
  private val accentRaw get() = paletteColor("accent", "#7ab537")
  /** The accent as text on [bg] (totals, change, discounts, greeting): lightened towards ivory to reach WCAG AA. */
  private fun accentTextOn(bg: Int) = toContrast(accentRaw, ivory, bg, 4.5)
  /** The accent as a bar / strip on the backdrop (non-text, 3:1). */
  private val accentMark get() = toContrast(accentRaw, ivory, backdrop, 3.0)
  /** Secondary text on [bg]: ivory softened into it, but never below 4.5:1. */
  private fun mutedOn(bg: Int) = toContrast(mix(ivory, bg, 0.3f), ivory, bg, 4.5)
  /** Hairline divider on the panel. */
  private val divider get() = mix(panel, ivory, 0.22f)

  private fun font(family: String): Typeface = try {
    ReactFontManager.getInstance().getTypeface(family, Typeface.NORMAL, context.assets)
  } catch (e: Exception) {
    Typeface.SANS_SERIF
  }

  private fun styleText(tv: TextView, family: String, sizeFraction: Float, color: Int) {
    tv.typeface = font(family)
    tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, screenH * sizeFraction)
    tv.setTextColor(color)
    tv.includeFontPadding = false
  }

  private fun text(): TextView = TextView(context).apply { setSingleLine(false) }

  /** A flat, solid rounded rectangle (GradientDrawable is only used for its corner radius — a single colour, no gradient). */
  private fun solidRounded(color: Int, radius: Float) = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = radius
    setColor(color)
  }

  // ---- layout ----------------------------------------------------------------------------------------------------

  private fun build() {
    val match = ViewGroup.LayoutParams.MATCH_PARENT
    val wrap = ViewGroup.LayoutParams.WRAP_CONTENT
    root = FrameLayout(context)

    split = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    root.addView(split, FrameLayout.LayoutParams(match, match))

    // Left: brand — the backdrop pane (the outlined logo straight on it, no card) plus a thin accent strip: down the
    // inner edge in the split, along the bottom when the brand is full-screen.
    brandHost = FrameLayout(context)
    brandPane = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(px(0.05f), px(0.05f), px(0.05f), px(0.05f))
    }
    brandHost.addView(brandPane, FrameLayout.LayoutParams(match, match))
    brandBandSide = View(context)
    brandHost.addView(brandBandSide, FrameLayout.LayoutParams(bandSideW(), match, Gravity.END))
    brandBandBottom = View(context).apply { visibility = View.GONE }
    brandHost.addView(brandBandBottom, FrameLayout.LayoutParams(match, bandBottomH(), Gravity.BOTTOM))
    // The logo's size is set from the bitmap's aspect ratio in layoutLogo() (so small logos are scaled UP too); the
    // view shows the outlined render at exactly its pixel size.
    brandLogo = ImageView(context).apply {
      scaleType = ImageView.ScaleType.FIT_CENTER
      visibility = View.GONE
    }
    brandPane.addView(brandLogo, LinearLayout.LayoutParams(wrap, wrap).apply { bottomMargin = px(0.045f) })
    brandName = text().apply {
      gravity = Gravity.CENTER
      maxLines = 3
      ellipsize = TextUtils.TruncateAt.END
    }
    brandPane.addView(brandName, LinearLayout.LayoutParams(wrap, wrap))
    brandAccent = View(context)
    brandPane.addView(brandAccent, LinearLayout.LayoutParams((screenW * 0.1f).toInt(), px(0.012f)).apply { topMargin = px(0.035f) })
    split.addView(brandHost, LinearLayout.LayoutParams(0, match, 1f))
    applyBrandBands()

    // Right: order breakdown / thank you, on the darker panel.
    rightPane = FrameLayout(context)
    split.addView(rightPane, LinearLayout.LayoutParams(0, match, 1f))

    cartPane = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(px(0.05f), px(0.05f), px(0.05f), px(0.045f))
    }
    heading = text()
    cartPane.addView(heading, LinearLayout.LayoutParams(match, wrap))
    greeting = text()
    cartPane.addView(greeting, LinearLayout.LayoutParams(match, wrap).apply { topMargin = px(0.008f) })
    linesScroll = ScrollView(context).apply { isVerticalScrollBarEnabled = false }
    linesBox = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    linesScroll.addView(linesBox, FrameLayout.LayoutParams(match, wrap))
    cartPane.addView(linesScroll, LinearLayout.LayoutParams(match, 0, 1f).apply { topMargin = px(0.02f) })
    val dividerView = View(context).apply { tag = "divider" }
    cartPane.addView(dividerView, LinearLayout.LayoutParams(match, maxOf(2, px(0.003f))).apply { topMargin = px(0.015f) })
    totalsBox = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    cartPane.addView(totalsBox, LinearLayout.LayoutParams(match, wrap).apply { topMargin = px(0.015f) })
    // The "due" box: grand total (large, accent) + cash received / change, on the backdrop colour.
    dueBox = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(px(0.03f), px(0.018f), px(0.03f), px(0.018f))
    }
    val grandRow = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL or Gravity.END
    }
    grandLabel = text()
    grandValue = text().apply { gravity = Gravity.END; maxLines = 1 }
    grandRow.addView(grandLabel, LinearLayout.LayoutParams(0, wrap, 1f))
    grandRow.addView(grandValue, LinearLayout.LayoutParams(wrap, wrap))
    dueBox.addView(grandRow, LinearLayout.LayoutParams(match, wrap))
    paymentBox = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    dueBox.addView(paymentBox, LinearLayout.LayoutParams(match, wrap).apply { topMargin = px(0.008f) })
    cartPane.addView(dueBox, LinearLayout.LayoutParams(match, wrap).apply { topMargin = px(0.02f) })
    rightPane.addView(cartPane, FrameLayout.LayoutParams(match, match))

    thanksPane = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(px(0.06f), px(0.06f), px(0.06f), px(0.06f))
    }
    thanksTitle = text().apply { gravity = Gravity.CENTER }
    thanksPane.addView(thanksTitle, LinearLayout.LayoutParams(match, wrap))
    thanksSubtitle = text().apply { gravity = Gravity.CENTER }
    thanksPane.addView(thanksSubtitle, LinearLayout.LayoutParams(match, wrap).apply { topMargin = px(0.02f) })
    thanksRows = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(px(0.035f), px(0.025f), px(0.035f), px(0.025f))
    }
    thanksPane.addView(thanksRows, LinearLayout.LayoutParams(match, wrap).apply { topMargin = px(0.05f) })
    rightPane.addView(thanksPane, FrameLayout.LayoutParams(match, match))

    // Idle: ads, full-screen, on top.
    adImage = ImageView(context).apply {
      scaleType = ImageView.ScaleType.FIT_CENTER
      visibility = View.GONE
    }
    root.addView(adImage, FrameLayout.LayoutParams(match, match))

    setContentView(root)
  }

  private fun applyConfig() {
    val bg = backdrop
    val pn = panel
    brandPane.setBackgroundColor(bg)
    brandAccent.setBackgroundColor(accentMark)
    brandBandSide.setBackgroundColor(accentMark)
    brandBandBottom.setBackgroundColor(accentMark)
    rightPane.setBackgroundColor(pn)
    adImage.setBackgroundColor(bg)
    root.setBackgroundColor(bg)
    cartPane.findViewWithTag<View>("divider")?.setBackgroundColor(divider)
    val corner = px(0.014f).toFloat()
    dueBox.background = solidRounded(bg, corner)
    thanksRows.background = solidRounded(bg, corner)
    styleText(brandName, "Poppins_600SemiBold", 0.07f, ivory)
    brandName.text = config.brandName
    brandName.visibility = if (config.brandName.isBlank()) View.GONE else View.VISIBLE
    styleText(heading, "Poppins_600SemiBold", 0.04f, ivory)
    styleText(greeting, "Poppins_500Medium", 0.03f, accentTextOn(pn))
    styleText(grandLabel, "Poppins_600SemiBold", 0.045f, ivory)
    styleText(grandValue, "Poppins_700Bold", 0.085f, accentTextOn(bg))
    styleText(thanksTitle, "Poppins_700Bold", 0.1f, ivory)
    styleText(thanksSubtitle, "Poppins_400Regular", 0.038f, mutedOn(pn))
    loadLogo()
    // The ad list may have changed: restart the slideshow from the first ad.
    adIndex = 0
    adsPlaying = false
    adGeneration++
  }

  private fun applyScreen() {
    when (val s = current) {
      is DisplayScreen.Idle -> showIdle()
      is DisplayScreen.Cart -> {
        stopAds()
        showSplit()
        cartPane.visibility = View.VISIBLE
        thanksPane.visibility = View.GONE
        bindCart(s.state)
      }
      is DisplayScreen.ThankYou -> {
        stopAds()
        showSplit()
        cartPane.visibility = View.GONE
        thanksPane.visibility = View.VISIBLE
        bindThanks(s.state)
      }
    }
  }

  private fun showSplit() {
    setBrandPaneFullWidth(false)
    adImage.visibility = View.GONE
    split.visibility = View.VISIBLE
    rightPane.visibility = View.VISIBLE
  }

  /** Brand full-screen (no ads to show). */
  private fun showBrandOnly() {
    setBrandPaneFullWidth(true)
    adImage.visibility = View.GONE
    split.visibility = View.VISIBLE
    rightPane.visibility = View.GONE
  }

  private fun showIdle() {
    if (config.ads.isEmpty()) {
      stopAds()
      showBrandOnly()
      return
    }
    if (!adsPlaying) {
      adsPlaying = true
      showBrandOnly() // until the first ad is decoded
      showAd(adGeneration, 0)
    }
  }

  private fun stopAds() {
    adsPlaying = false
    adGeneration++
    main.removeCallbacksAndMessages(null)
  }

  // ---- cart / thank you ------------------------------------------------------------------------------------------

  private fun bindCart(s: JSONObject) {
    val pn = panel
    val bg = backdrop
    heading.text = s.optString("heading", "")
    val g = s.optString("greeting", "")
    greeting.text = g
    greeting.visibility = if (g.isBlank() || s.isNull("greeting")) View.GONE else View.VISIBLE

    linesBox.removeAllViews()
    val lines = s.optJSONArray("lines") ?: JSONArray()
    for (i in 0 until lines.length()) {
      val l = lines.optJSONObject(i) ?: continue
      linesBox.addView(lineRow(l, pn, i > 0), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }
    // Keep the latest item in view.
    linesScroll.post { linesScroll.fullScroll(View.FOCUS_DOWN) }

    totalsBox.removeAllViews()
    val totals = s.optJSONArray("totals") ?: JSONArray()
    for (i in 0 until totals.length()) {
      val t = totals.optJSONObject(i) ?: continue
      val tone = when (t.optString("tone")) {
        "discount" -> accentTextOn(pn)
        "muted" -> mutedOn(pn)
        else -> ivory
      }
      totalsBox.addView(pairRow(t.optString("label"), t.optString("value"), 0.03f, tone, "Poppins_400Regular", "Poppins_500Medium"))
    }

    grandLabel.text = s.optString("grandTotalLabel", "")
    grandValue.text = s.optString("grandTotal", "")

    paymentBox.removeAllViews()
    val payment = s.optJSONArray("payment") ?: JSONArray()
    for (i in 0 until payment.length()) {
      val p = payment.optJSONObject(i) ?: continue
      val c = if (p.optBoolean("accent", false)) accentTextOn(bg) else ivory
      paymentBox.addView(pairRow(p.optString("label"), p.optString("value"), 0.036f, c, "Poppins_500Medium", "Poppins_600SemiBold"))
    }
    paymentBox.visibility = if (payment.length() > 0) View.VISIBLE else View.GONE
  }

  private fun lineRow(l: JSONObject, bg: Int, separated: Boolean): View {
    val outer = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    if (separated) {
      // Hairline between lines, so a long list stays easy to follow on the dark panel.
      val rule = View(context).apply { setBackgroundColor(mix(bg, ivory, 0.12f)) }
      outer.addView(rule, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, maxOf(1, px(0.0015f))))
    }
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(0, px(0.012f), 0, px(0.012f))
    }
    val top = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    val name = text().apply {
      maxLines = 2
      ellipsize = TextUtils.TruncateAt.END
      text = l.optString("name")
    }
    styleText(name, "Poppins_500Medium", 0.032f, ivory)
    val amount = text().apply {
      gravity = Gravity.END
      maxLines = 1
      text = l.optString("amount")
    }
    styleText(amount, "Poppins_600SemiBold", 0.032f, ivory)
    top.addView(name, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = px(0.02f) })
    top.addView(amount, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    row.addView(top)
    val detail = text().apply { text = l.optString("detail") }
    styleText(detail, "Poppins_400Regular", 0.026f, mutedOn(bg))
    row.addView(detail, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = px(0.004f) })
    val discounts = l.optJSONArray("discounts") ?: JSONArray()
    for (i in 0 until discounts.length()) {
      val d = discounts.optJSONObject(i) ?: continue
      row.addView(pairRow(d.optString("label"), d.optString("value"), 0.026f, accentTextOn(bg), "Poppins_400Regular", "Poppins_500Medium"))
    }
    outer.addView(row)
    return outer
  }

  private fun pairRow(label: String, value: String, size: Float, color: Int, labelFont: String, valueFont: String): View {
    val row = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      setPadding(0, px(0.004f), 0, px(0.004f))
    }
    val l = text().apply {
      text = label
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
    }
    styleText(l, labelFont, size, color)
    val v = text().apply {
      text = value
      gravity = Gravity.END
      maxLines = 1
    }
    styleText(v, valueFont, size, color)
    row.addView(l, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = px(0.02f) })
    row.addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    return row
  }

  private fun bindThanks(s: JSONObject) {
    val bg = backdrop
    thanksTitle.text = s.optString("title", "")
    val sub = s.optString("subtitle", "")
    thanksSubtitle.text = sub
    thanksSubtitle.visibility = if (sub.isBlank()) View.GONE else View.VISIBLE
    thanksRows.removeAllViews()
    val rows = s.optJSONArray("rows") ?: JSONArray()
    for (i in 0 until rows.length()) {
      val r = rows.optJSONObject(i) ?: continue
      val c = if (r.optBoolean("accent", false)) accentTextOn(bg) else ivory
      thanksRows.addView(pairRow(r.optString("label"), r.optString("value"), 0.042f, c, "Poppins_500Medium", "Poppins_700Bold"))
    }
    thanksRows.visibility = if (rows.length() > 0) View.VISIBLE else View.GONE
  }

  // ---- images ----------------------------------------------------------------------------------------------------

  // Logo box: at most ~40% of the brand pane's width and ~45% of its height, aspect preserved.
  private fun logoBoxW(fullWidth: Boolean): Int = ((if (fullWidth) screenW else screenW / 2f) * 0.40f).toInt()
  private fun logoBoxH(): Int = px(0.45f)
  // Accent strip: ~0.6% of the screen width on the pane's inner edge (split), ~0.8% of its height at the bottom
  // (brand full-screen) — a thin line, the two colour fields do the separating.
  private fun bandSideW(): Int = (screenW * 0.006f).toInt().coerceAtLeast(3)
  private fun bandBottomH(): Int = px(0.008f).coerceAtLeast(3)
  /** The logo's white contour, in screen pixels: 3 px on a 1080p monitor (≈0.3% of the height), kept within 2–5 px. */
  private fun outlineWidth(): Int = (screenH * 0.003f).roundToInt().coerceIn(2, 5)

  private fun setBrandPaneFullWidth(full: Boolean) {
    if (brandPaneFullWidth == full) return
    brandPaneFullWidth = full
    applyBrandBands()
    layoutLogo()
  }

  /** Shows the strip that fits the current layout and keeps the pane's content clear of it. */
  private fun applyBrandBands() {
    val full = brandPaneFullWidth
    brandBandSide.visibility = if (full) View.GONE else View.VISIBLE
    brandBandBottom.visibility = if (full) View.VISIBLE else View.GONE
    val lp = brandPane.layoutParams as FrameLayout.LayoutParams
    val end = if (full) 0 else bandSideW()
    val bottom = if (full) bandBottomH() else 0
    if (lp.marginEnd != end || lp.bottomMargin != bottom) {
      lp.marginEnd = end
      lp.bottomMargin = bottom
      brandPane.layoutParams = lp
    }
  }

  private fun logoKey(path: String?): String? {
    if (path == null) return null
    val f = java.io.File(path)
    return "$path|${f.length()}|${f.lastModified()}"
  }

  private fun loadLogo() {
    val path = config.logoPath
    val key = logoKey(path)
    if (key == logoKeyLoaded && (path == null || logoBitmap != null)) {
      bindLogo()
      return
    }
    logoKeyLoaded = key
    val gen = ++logoGeneration
    if (path == null) {
      setLogoBitmap(null)
      bindLogo()
      return
    }
    // Keep showing the previous logo until the new one is decoded (no flash of the name-only layout).
    val maxW = logoBoxW(true)
    val maxH = logoBoxH()
    submit {
      val bmp = decodeSampled(path, maxW, maxH)
      main.post {
        if (released || gen != logoGeneration) return@post
        setLogoBitmap(bmp)
        if (bmp == null) logoKeyLoaded = null // retried on the next config
        bindLogo()
      }
    }
  }

  /** A new source logo: the outlined renders of the old one no longer apply. */
  private fun setLogoBitmap(bmp: Bitmap?) {
    logoBitmap = bmp
    outlinedLogos.clear()
    wantedOutlineKey = null
  }

  private fun bindLogo() {
    val bmp = logoBitmap
    // No logo (or it can't be decoded) → the brand name alone, centred by the pane's gravity.
    if (bmp == null) brandLogo.setImageBitmap(null)
    brandLogo.visibility = if (bmp == null) View.GONE else View.VISIBLE
    layoutLogo()
  }

  /**
   * Sizes the logo to fit its box for the current pane width (aspect kept) and shows the outlined render for exactly
   * that size — built off the main thread the first time, then cached (split and full-screen sizes).
   */
  private fun layoutLogo() {
    val bmp = logoBitmap ?: return
    if (bmp.width <= 0 || bmp.height <= 0) return
    val boxW = logoBoxW(brandPaneFullWidth).coerceAtLeast(1)
    val boxH = logoBoxH().coerceAtLeast(1)
    val scale = minOf(boxW.toFloat() / bmp.width, boxH.toFloat() / bmp.height)
    val w = (bmp.width * scale).toInt().coerceAtLeast(1)
    val h = (bmp.height * scale).toInt().coerceAtLeast(1)
    val stroke = outlineWidth()
    val lp = brandLogo.layoutParams
    if (lp.width != w + 2 * stroke || lp.height != h + 2 * stroke) {
      lp.width = w + 2 * stroke
      lp.height = h + 2 * stroke
      brandLogo.layoutParams = lp
    }
    val key = "${w}x${h}x$stroke"
    wantedOutlineKey = key
    val ready = outlinedLogos[key]
    if (ready != null) {
      brandLogo.setImageBitmap(ready)
      return
    }
    // Until the outlined render is ready: the plain logo (first time) or the previous render, scaled to fit.
    if (brandLogo.drawable == null) brandLogo.setImageBitmap(bmp)
    val gen = logoGeneration
    submit {
      val out = try {
        outlinedLogo(bmp, w, h, stroke)
      } catch (e: Throwable) {
        Log.w(TAG, "Could not outline the logo", e)
        null
      }
      main.post {
        if (released || gen != logoGeneration || logoBitmap !== bmp || out == null) return@post
        outlinedLogos[key] = out
        if (wantedOutlineKey == key) brandLogo.setImageBitmap(out)
      }
    }
  }

  /**
   * The logo at [w]×[h] with a thin white contour that follows its SHAPE (the PNG's alpha), not its bounding box.
   *
   * Technique: a white silhouette of the logo — the same bitmap drawn through a SRC_IN colour filter, which paints
   * every pixel white while keeping its alpha — is stamped [stroke] px away in 16 directions (plus 8 more at half the
   * distance, so thin strokes and sharp corners leave no gaps); the union of those shifted silhouettes is the logo
   * "grown" by [stroke] px. The original is then drawn on top, so only a [stroke]-wide white rim shows around every
   * opaque edge (inner holes included). The logo is scaled to its on-screen size first, so the rim is exactly
   * [stroke] screen pixels whatever the file's resolution. A logo without transparency (JPEG, opaque PNG) is a full
   * rectangle, so its contour is naturally a thin rectangular border. ~25 draws of one small bitmap, once per size.
   */
  private fun outlinedLogo(src: Bitmap, w: Int, h: Int, stroke: Int): Bitmap {
    val out = Bitmap.createBitmap(w + 2 * stroke, h + 2 * stroke, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val scaled = if (src.width == w && src.height == h) src else Bitmap.createScaledBitmap(src, w, h, true)
    val silhouette = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
      colorFilter = PorterDuffColorFilter(Color.WHITE, PorterDuff.Mode.SRC_IN)
    }
    val origin = stroke.toFloat()
    for ((radius, steps) in listOf(stroke.toFloat() to 16, stroke / 2f to 8)) {
      for (i in 0 until steps) {
        val a = 2.0 * Math.PI * i / steps
        canvas.drawBitmap(scaled, origin + (radius * cos(a)).toFloat(), origin + (radius * sin(a)).toFloat(), silhouette)
      }
    }
    canvas.drawBitmap(scaled, origin, origin, Paint(Paint.FILTER_BITMAP_FLAG))
    if (scaled !== src) scaled.recycle()
    return out
  }

  /** Decodes ad [index] off the main thread, shows it, and schedules the next one after its duration. */
  private fun showAd(gen: Int, index: Int, failuresInARow: Int = 0) {
    val ads = config.ads
    if (ads.isEmpty() || gen != adGeneration) return
    if (failuresInARow >= ads.size) {
      // None of the ads can be decoded — show the brand instead (checked again when the config changes).
      showBrandOnly()
      return
    }
    val i = index % ads.size
    val ad = ads[i]
    val w = screenW.toInt()
    val h = screenH.toInt()
    submit {
      val bmp = decodeSampled(ad.path, w, h)
      main.post {
        if (released || gen != adGeneration || current !is DisplayScreen.Idle) return@post
        if (bmp == null) {
          showAd(gen, i + 1, failuresInARow + 1)
          return@post
        }
        adIndex = i
        adImage.setImageBitmap(bmp)
        adImage.visibility = View.VISIBLE
        split.visibility = View.GONE
        if (ads.size > 1) {
          main.postDelayed({ showAd(gen, i + 1) }, ad.durationSeconds * 1000L)
        }
      }
    }
  }

  private fun submit(task: () -> Unit) {
    if (released || decoder.isShutdown) return
    try {
      decoder.execute(task)
    } catch (e: Exception) {
      Log.w(TAG, "Could not queue an image decode", e)
    }
  }

  private fun decodeSampled(path: String, reqW: Int, reqH: Int): Bitmap? = try {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      null
    } else {
      var sample = 1
      while (bounds.outWidth / (sample * 2) >= reqW && bounds.outHeight / (sample * 2) >= reqH) sample *= 2
      BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
    }
  } catch (e: Throwable) {
    Log.w(TAG, "Could not decode $path", e)
    null
  }
}
