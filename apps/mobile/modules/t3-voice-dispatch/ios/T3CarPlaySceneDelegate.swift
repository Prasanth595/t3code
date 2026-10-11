import CarPlay

/// Named in the app's scene manifest by the withVoiceDispatch config plugin.
/// CarPlay may connect before the phone scene exists; the bridge starts
/// React Native in that case.
@objc(T3CarPlaySceneDelegate)
public final class T3CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    MainActor.assumeIsolated {
      T3VoiceDispatchBridge.shared.carPlayDidConnect(interfaceController)
    }
  }

  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnect interfaceController: CPInterfaceController
  ) {
    MainActor.assumeIsolated {
      T3VoiceDispatchBridge.shared.carPlayDidDisconnect()
    }
  }
}
