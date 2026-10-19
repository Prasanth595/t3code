import UIKit

// Only the Expo bridge is stubbed; the editor and text layout use production UIKit code.
public class AppContext {}

open class ExpoView: UIView {
  public required init(appContext: AppContext? = nil) {
    super.init(frame: .zero)
  }

  @available(*, unavailable)
  public required init?(coder: NSCoder) { nil }
}

public struct EventDispatcher {
  public init() {}
  public func callAsFunction(_ payload: [String: Any] = [:]) {}
}
