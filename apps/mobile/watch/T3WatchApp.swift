import SwiftUI

@main
struct T3WatchApp: App {
  @StateObject private var model = WatchModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      WatchHomeView(model: model)
        .onAppear { model.isForeground = scenePhase == .active }
        .onChange(of: scenePhase) { _, phase in
          model.isForeground = phase == .active
          if phase == .active { model.refreshAndTransfer() }
        }
    }
  }
}
