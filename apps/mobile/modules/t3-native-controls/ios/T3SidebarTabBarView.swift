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
    tabBar.items = [
      UITabBarItem(title: "Threads", image: UIImage(systemName: "text.bubble"), tag: 0),
      UITabBarItem(title: "Pull requests", image: UIImage(systemName: "arrow.triangle.pull"), tag: 1),
    ]
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
