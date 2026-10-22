import ExpoModulesCore
import UIKit

final class T3SidebarTabBarView: ExpoView, UITabBarDelegate {
  let onSelectionChange = EventDispatcher()
  private let tabBar = UITabBar()
  var selectedIndex = 0 { didSet { updateSelection() } }
  var selectedColor: UIColor = .systemBlue { didSet { tabBar.tintColor = selectedColor } }
  var appearance = "light" {
    didSet { overrideUserInterfaceStyle = appearance == "dark" ? .dark : .light }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let iconBundle = Bundle(for: Self.self).url(forResource: "T3NativeControlIcons", withExtension: "bundle").flatMap(Bundle.init(url:))
    let pullRequestIcon = UIImage(named: "pull-request", in: iconBundle, compatibleWith: nil)?.withRenderingMode(.alwaysTemplate)
    tabBar.items = [
      UITabBarItem(title: "Threads", image: UIImage(systemName: "text.bubble"), tag: 0),
      UITabBarItem(title: "Pulls", image: pullRequestIcon, tag: 1),
    ]
    tabBar.items?.last?.accessibilityLabel = "Pull requests"
    tabBar.items?.first?.selectedImage = UIImage(systemName: "text.bubble.fill")
    tabBar.itemPositioning = .fill
    tabBar.delegate = self
    addSubview(tabBar)
    updateSelection()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    tabBar.frame = bounds
    updateSelection()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateSelection()
  }

  private func updateSelection() {
    guard let items = tabBar.items, items.indices.contains(selectedIndex) else { return }
    guard tabBar.selectedItem !== items[selectedIndex] else { return }
    tabBar.selectedItem = items[selectedIndex]
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    onSelectionChange(["index": item.tag])
  }
}
