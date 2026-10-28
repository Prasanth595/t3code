import ExpoModulesCore

public final class T3WatchBridgeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3WatchBridge")
    Constant("isEnabled") { WatchReceiver.isEnabled }
    Events("onRecordingsChanged", "onAction")

    OnCreate { [weak self] in
      guard WatchReceiver.isEnabled else { return }
      DispatchQueue.main.async { [weak self] in
        WatchReceiver.shared.onRecordingsChanged = { [weak self] in self?.sendEvent("onRecordingsChanged", [:]) }
        WatchReceiver.shared.onAction = { [weak self] payload in self?.sendEvent("onAction", payload) }
        do { try WatchReceiver.shared.start() } catch { NSLog("T3 Watch receiver startup failed: %@", error.localizedDescription) }
      }
    }
    OnStartObserving("onAction") {
      guard WatchReceiver.isEnabled else { return }
      DispatchQueue.main.async { WatchReceiver.shared.beginObservingActions() }
    }
    OnStopObserving("onAction") {
      guard WatchReceiver.isEnabled else { return }
      DispatchQueue.main.async { WatchReceiver.shared.observing = false }
    }
    OnDestroy {
      guard WatchReceiver.isEnabled else { return }
      DispatchQueue.main.async {
        WatchReceiver.shared.observing = false
        WatchReceiver.shared.onRecordingsChanged = nil
        WatchReceiver.shared.onAction = nil
      }
    }
    AsyncFunction("listRecordings") { () throws -> [[String: Any]] in
      try WatchReceiver.shared.list()
    }
    AsyncFunction("removeRecording") { (id: String) throws in
      try WatchReceiver.shared.remove(id)
    }
    AsyncFunction("publishSnapshot") { (json: String) throws in
      try WatchReceiver.shared.publish(json)
    }
    AsyncFunction("listPendingActions") { () throws -> [[String: Any]] in
      try WatchReceiver.shared.listPendingActions()
    }
    AsyncFunction("removeAction") { (id: String) throws in
      try WatchReceiver.shared.removeAction(id)
    }
  }
}
