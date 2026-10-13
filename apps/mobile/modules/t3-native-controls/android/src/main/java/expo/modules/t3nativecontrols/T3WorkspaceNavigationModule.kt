package expo.modules.t3nativecontrols

import android.content.Context
import android.view.ViewGroup
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class T3WorkspaceNavigationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3WorkspaceNavigation")
    View(T3WorkspaceNavigationView::class) {
      Prop("selectedTab") { view: T3WorkspaceNavigationView, value: String ->
        view.selectedTab = value
      }
      Prop("rail") { view: T3WorkspaceNavigationView, value: Boolean -> view.rail = value }
      Prop("dark") { view: T3WorkspaceNavigationView, value: Boolean -> view.dark = value }
      Prop("textScale") { view: T3WorkspaceNavigationView, value: Float -> view.textScale = value }
      Prop("iconSize") { view: T3WorkspaceNavigationView, value: Float -> view.iconSize = value }
      Prop("containerColor") { view: T3WorkspaceNavigationView, value: Int ->
        view.containerColor = value
      }
      Prop("selectedColor") { view: T3WorkspaceNavigationView, value: Int ->
        view.selectedColor = value
      }
      Prop("indicatorColor") { view: T3WorkspaceNavigationView, value: Int ->
        view.indicatorColor = value
      }
      Prop("unselectedColor") { view: T3WorkspaceNavigationView, value: Int ->
        view.unselectedColor = value
      }
      Events("onTabSelected")
    }
  }
}

/** Compact windows use an icon pill; expanded windows retain the Material navigation rail. */
class T3WorkspaceNavigationView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  // Compose must remeasure native children when Yoga resizes the folded window.
  override val shouldUseAndroidLayout = true

  private val onTabSelected by EventDispatcher()
  var selectedTab by mutableStateOf("threads")
  var rail by mutableStateOf(false)
  var dark by mutableStateOf(false)
  var textScale by mutableStateOf(1f)
  var iconSize by mutableStateOf(24f)
  var containerColor by mutableStateOf(0)
  var selectedColor by mutableStateOf(0)
  var indicatorColor by mutableStateOf(0)
  var unselectedColor by mutableStateOf(0)

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    // Fabric measures the replacement bar before attaching it on a fold.
    // Compose needs an attached window to obtain its lifecycle recomposer.
    if (!isAttachedToWindow) {
      setMeasuredDimension(
        MeasureSpec.getSize(widthMeasureSpec),
        MeasureSpec.getSize(heightMeasureSpec)
      )
      return
    }
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    if (isAttachedToWindow) super.onLayout(changed, left, top, right, bottom)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    requestLayout()
  }

  init {
    clipChildren = false
    clipToPadding = false
    addView(
      ComposeView(context).apply {
        clipChildren = false
        clipToPadding = false
        setViewCompositionStrategy(
          ViewCompositionStrategy.DisposeOnDetachedFromWindowOrReleasedFromPool
        )
        setContent {
          MaterialTheme(colorScheme = if (dark) darkColorScheme() else lightColorScheme()) {
            val tabs = listOf("threads", "pullRequests")
            if (rail) {
              NavigationRail(
                modifier = Modifier.fillMaxSize(),
                containerColor = Color(containerColor),
                windowInsets = WindowInsets(0),
              ) {
                Spacer(Modifier.weight(1f))
                tabs.forEach { tab ->
                  NavigationRailItem(
                    selected = selectedTab == tab,
                    onClick = { onTabSelected(mapOf("tab" to tab)) },
                    icon = { tabIcon(tab) },
                    label = {
                      val title = if (tab == "threads") "Chats" else "PRs"
                      Text(title, fontSize = (12 * textScale).sp)
                    },
                    colors = NavigationRailItemDefaults.colors(
                      selectedIconColor = Color(selectedColor),
                      selectedTextColor = Color(selectedColor),
                      indicatorColor = Color(indicatorColor),
                      unselectedIconColor = Color(unselectedColor),
                      unselectedTextColor = Color(unselectedColor),
                    ),
                  )
                }
                Spacer(Modifier.weight(1f))
              }
            } else {
              Surface(
                modifier = Modifier.fillMaxSize(),
                shape = CircleShape,
                color = Color(containerColor),
                // Match the resting elevation of the Compose New thread FAB.
                shadowElevation = 6.dp,
              ) {
                Row(
                  modifier = Modifier.fillMaxSize().selectableGroup(),
                  verticalAlignment = Alignment.CenterVertically,
                ) {
                  tabs.forEach { tab ->
                    val selected = selectedTab == tab
                    Box(
                      modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clip(CircleShape)
                        .selectable(
                          selected = selected,
                          role = Role.Tab,
                          onClick = { onTabSelected(mapOf("tab" to tab)) },
                        )
                        .padding(4.dp)
                        .background(
                          if (selected) Color(indicatorColor) else Color.Transparent,
                          CircleShape,
                        ),
                      contentAlignment = Alignment.Center,
                    ) {
                      tabIcon(
                        tab,
                        Color(if (selected) selectedColor else unselectedColor),
                        Modifier.size(iconSize.dp),
                      )
                    }
                  }
                }
              }
            }
          }
        }
      },
      LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    )
  }

  @Composable
  private fun tabIcon(
    tab: String,
    tint: Color = LocalContentColor.current,
    modifier: Modifier = Modifier
  ) {
    val drawable = if (tab == "threads") {
      R.drawable.t3_chats
    } else {
      R.drawable.t3_pull_requests
    }
    Icon(
      painter = painterResource(drawable),
      contentDescription = if (tab == "threads") "Chats" else "Pull requests",
      modifier = modifier,
      tint = tint,
    )
  }
}
