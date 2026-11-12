package dev.maxbuda.handoff

import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.LongTextComplicationData
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.MonochromaticImageComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.data.SmallImage
import androidx.wear.watchface.complications.data.SmallImageComplicationData
import androidx.wear.watchface.complications.data.SmallImageType
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

class HandOffApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Store.init(this)
    }
}

/** Opens Hand-Off ready to jot an idea (what the tile and complication do when tapped). */
private fun jotIntent(c: Context) = Intent(MainActivity.ACTION_JOT).setClass(c, MainActivity::class.java)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

/** The tile, one swipe from the watch face: a button that opens Hand-Off ready to dictate an idea. */
class HandOffTile : TileService() {
    override fun onTileRequest(req: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> {
        val launch = ActionBuilders.LaunchAction.Builder()
            .setAndroidActivity(ActionBuilders.AndroidActivity.Builder()
                .setPackageName(packageName)
                .setClassName(MainActivity::class.java.name)
                .addKeyToExtraMapping(MainActivity.EXTRA_JOT, ActionBuilders.AndroidBooleanExtra.Builder().setValue(true).build())
                .build())
            .build()
        val accent = Store.theme.color
        val button = LayoutElementBuilders.Box.Builder()
            .setWidth(dp(140f)).setHeight(dp(52f))
            .setModifiers(ModifiersBuilders.Modifiers.Builder()
                .setClickable(ModifiersBuilders.Clickable.Builder().setId("jot").setOnClick(launch).build())
                .setBackground(ModifiersBuilders.Background.Builder()
                    .setColor(argb(argbOf(accent)))
                    .setCorner(ModifiersBuilders.Corner.Builder().setRadius(dp(26f)).build())
                    .build())
                .build())
            .addContent(text(getString(R.string.jot_an_idea), 15f, 0xFF000000.toInt(), bold = true))
            .build()
        val layout = LayoutElementBuilders.Column.Builder()
            .setWidth(expand())
            .setHorizontalAlignment(LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER)
            .addContent(text(getString(R.string.app_name), 16f, argbOf(accent), bold = true))
            .addContent(LayoutElementBuilders.Spacer.Builder().setHeight(dp(10f)).build())
            .addContent(button)
            .apply {
                val waiting = Store.pending
                if (waiting > 0) {
                    addContent(LayoutElementBuilders.Spacer.Builder().setHeight(dp(8f)).build())
                    addContent(text(resources.getQuantityString(R.plurals.waiting_count, waiting, waiting), 12f, 0xFFAAAAAA.toInt()))
                }
            }
            .build()
        val root = LayoutElementBuilders.Box.Builder().setWidth(expand()).setHeight(expand()).addContent(layout).build()
        return Futures.immediateFuture(TileBuilders.Tile.Builder()
            .setResourcesVersion("1")
            .setFreshnessIntervalMillis(0)
            .setTileTimeline(TimelineBuilders.Timeline.fromLayoutElement(root))
            .build())
    }

    override fun onTileResourcesRequest(req: RequestBuilders.ResourcesRequest): ListenableFuture<ResourceBuilders.Resources> =
        Futures.immediateFuture(ResourceBuilders.Resources.Builder().setVersion("1").build())

    private fun text(s: String, size: Float, color: Int, bold: Boolean = false) = LayoutElementBuilders.Text.Builder()
        .setText(s)
        .setMaxLines(2)
        .setFontStyle(LayoutElementBuilders.FontStyle.Builder()
            .setSize(sp(size))
            .setColor(argb(color))
            .setWeight(if (bold) LayoutElementBuilders.FONT_WEIGHT_BOLD else LayoutElementBuilders.FONT_WEIGHT_NORMAL)
            .build())
        .build()

    private fun argbOf(c: androidx.compose.ui.graphics.Color): Int =
        android.graphics.Color.argb(255, (c.red * 255).toInt(), (c.green * 255).toInt(), (c.blue * 255).toInt())
}

/** The watch-face complication: one tap opens Hand-Off, ready to jot an idea. It shows nothing from Claude. */
class HandOffComplication : SuspendingComplicationDataSourceService() {
    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? = data(request.complicationType)

    override fun getPreviewData(type: ComplicationType): ComplicationData? = data(type)

    private fun data(type: ComplicationType): ComplicationData? {
        val tap = PendingIntent.getActivity(this, 0, jotIntent(this), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val icon = Icon.createWithResource(this, R.drawable.ic_glyph)
        val name = PlainComplicationText.Builder(getString(R.string.app_name)).build()
        val jot = PlainComplicationText.Builder(getString(R.string.jot_an_idea)).build()
        val mono = MonochromaticImage.Builder(icon).build()
        return when (type) {
            ComplicationType.SHORT_TEXT -> ShortTextComplicationData.Builder(name, jot).setMonochromaticImage(mono).setTapAction(tap).build()
            ComplicationType.LONG_TEXT -> LongTextComplicationData.Builder(jot, jot).setTitle(name).setMonochromaticImage(mono).setTapAction(tap).build()
            ComplicationType.MONOCHROMATIC_IMAGE -> MonochromaticImageComplicationData.Builder(mono, jot).setTapAction(tap).build()
            ComplicationType.SMALL_IMAGE -> SmallImageComplicationData.Builder(SmallImage.Builder(icon, SmallImageType.ICON).build(), jot).setTapAction(tap).build()
            else -> null
        }
    }
}
