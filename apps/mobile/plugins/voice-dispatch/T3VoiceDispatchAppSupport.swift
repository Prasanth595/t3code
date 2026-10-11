// Copied into the app target by plugins/withVoiceDispatch.cjs. App Intents
// must live in the app target for Siri to find them, and starting React
// Native needs the app delegate's factory.
import AppIntents
internal import Expo
import React
internal import T3VoiceDispatch
import UIKit

/// Starts the React Native app when CarPlay or Siri launch T3 Code before its
/// phone screen exists, and hands that running app to the phone screen later,
/// so there is only ever one React tree.
@objc(T3VoiceDispatchAppSupport)
final class T3VoiceDispatchAppSupport: NSObject, T3VoiceDispatchAppSupporting {
  @MainActor private static var headlessWindow: UIWindow?

  @MainActor static func startReactRuntime() {
    guard headlessWindow == nil,
          let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
          let factory = provider.reactNativeFactory,
          provider.window?.rootViewController == nil else {
      return
    }
    // The window is never shown; it owns the root view controller until a
    // phone scene adopts it. expo-updates looks for the app delegate's window.
    let window = UIWindow(frame: UIScreen.main.bounds)
    headlessWindow = window
    provider.window = window
    factory.startReactNative(
      withModuleName: provider.reactNativeFactoryModuleName,
      in: window,
      launchOptions: nil
    )
  }

  @MainActor static func projectsDidChange() {
    T3VoiceDispatchShortcuts.updateAppShortcutParameters()
  }

  /// Moves a headless app into the connecting phone scene. Returns nil when
  /// nothing started headless, so the scene delegate starts React Native itself.
  @MainActor static func adoptHeadlessApp(in windowScene: UIWindowScene) -> UIWindow? {
    guard let headless = headlessWindow,
          let rootViewController = headless.rootViewController,
          let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider else {
      return nil
    }
    headlessWindow = nil
    headless.rootViewController = nil
    let window = UIWindow(windowScene: windowScene)
    window.rootViewController = rootViewController
    provider.window = window
    window.makeKeyAndVisible()
    return window
  }
}

// MARK: - Siri

struct T3ProjectEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Project"
  static let defaultQuery = T3ProjectQuery()

  let id: String
  let title: String
  let subtitle: String?
  let spokenNames: [String]

  init(_ snapshot: VoiceDispatchProjectSnapshot) {
    id = snapshot.key
    title = snapshot.title
    subtitle = snapshot.subtitle
    spokenNames = snapshot.spokenNames
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: "\(title)",
      subtitle: subtitle.map { "\($0)" },
      synonyms: spokenNames.map { "\($0)" }
    )
  }
}

/// Projects come from the bridge's cache, which JS refreshes whenever its
/// project list changes, so Siri can resolve them before the app has started.
struct T3ProjectQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [T3ProjectEntity] {
    await allProjects().filter { identifiers.contains($0.id) }
  }

  func entities(matching string: String) async throws -> [T3ProjectEntity] {
    let needle = Self.compact(string)
    guard !needle.isEmpty else { return [] }
    return await allProjects().filter { project in
      ([project.title] + project.spokenNames).contains { name in
        let candidate = Self.compact(name)
        return candidate.contains(needle) || needle.contains(candidate)
      }
    }
  }

  func suggestedEntities() async throws -> [T3ProjectEntity] {
    await allProjects()
  }

  private func allProjects() async -> [T3ProjectEntity] {
    await MainActor.run { T3VoiceDispatchBridge.shared.projects.map(T3ProjectEntity.init) }
  }

  /// "T3 Code", "t3-code" and "t 3 code" all compare as "t3code".
  private static func compact(_ value: String) -> String {
    String(value.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains))
  }
}

struct T3IntentError: Error, CustomLocalizedStringResourceConvertible {
  let message: String

  var localizedStringResource: LocalizedStringResource { "\(message)" }
}

/// "Hey Siri, start a thread in T3 Code." Runs without opening the app, so it
/// works from CarPlay and the lock screen.
struct StartThreadIntent: AppIntent {
  static let title: LocalizedStringResource = "Start a Thread"
  static let description = IntentDescription(
    "Starts a new T3 Code thread in one of your projects from what you say."
  )

  @Parameter(title: "Project", requestValueDialog: IntentDialog("Which project?"))
  var project: T3ProjectEntity

  @Parameter(title: "Request", requestValueDialog: IntentDialog("What do you want to build?"))
  var request: String

  static var parameterSummary: some ParameterSummary {
    Summary("Start a thread in \(\.$project): \(\.$request)")
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    try await requestConfirmation(
      actionName: .start,
      dialog: IntentDialog("Start a thread in \(project.title)? \(request)")
    )
    let status: VoiceDispatchStartStatus
    do {
      status = try await T3VoiceDispatchBridge.shared.dispatch(projectKey: project.id, text: request)
    } catch {
      throw T3IntentError(message: error.localizedDescription)
    }
    switch status {
    case .started:
      return .result(dialog: "Started a thread in \(project.title).")
    case .queued:
      return .result(dialog: "Queued. It starts when \(project.title) reconnects.")
    }
  }
}

struct T3VoiceDispatchShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartThreadIntent(),
      phrases: [
        "Start a thread in \(.applicationName)",
        "Start a \(.applicationName) thread",
        "New \(.applicationName) thread",
        "Start a \(.applicationName) thread in \(\.$project)",
      ],
      shortTitle: "Start Thread",
      systemImageName: "waveform"
    )
  }
}
