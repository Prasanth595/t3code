import ExpoModulesCore

struct ProjectRecord: Record {
  @Field var key: String = ""
  @Field var title: String = ""
  @Field var subtitle: String?
  @Field var spokenNames: [String] = []
}

struct PromptButtonRecord: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var systemImage: String = ""
}

struct PromptRecord: Record {
  @Field var title: String = ""
  @Field var listening: Bool = false
  @Field var buttons: [PromptButtonRecord] = []
}

struct ListenRecord: Record {
  @Field var endSilenceMs: Int = 1500
  @Field var startTimeoutMs: Int = 8000
  @Field var maxDurationMs: Int = 60_000
  @Field var hints: [String] = []
}

/// JS side of hands-free dispatch. JS runs the CarPlay conversation through
/// these primitives and answers Siri's thread requests; see
/// apps/mobile/src/features/voice-dispatch.
public final class T3VoiceDispatchModule: Module {
  static let carPlaySessionEvent = "onCarPlaySession"
  static let buttonEvent = "onVoiceButton"
  static let dispatchRequestEvent = "onDispatchRequest"

  public func definition() -> ModuleDefinition {
    Name("T3VoiceDispatch")

    Events(Self.carPlaySessionEvent, Self.buttonEvent, Self.dispatchRequestEvent)

    OnDestroy {
      DispatchQueue.main.async {
        MainActor.assumeIsolated { T3VoiceDispatchBridge.shared.moduleWillUnload(self) }
      }
    }

    // Main-queue functions touch main-actor UI and audio state.
    AsyncFunction("markReady") {
      MainActor.assumeIsolated { T3VoiceDispatchBridge.shared.markReady(module: self) }
    }.runOnQueue(.main)

    AsyncFunction("setProjects") { (projects: [ProjectRecord]) in
      let snapshots = projects.map {
        VoiceDispatchProjectSnapshot(
          key: $0.key,
          title: $0.title,
          subtitle: $0.subtitle,
          spokenNames: $0.spokenNames
        )
      }
      MainActor.assumeIsolated { T3VoiceDispatchBridge.shared.updateProjects(snapshots) }
    }.runOnQueue(.main)

    AsyncFunction("resolveDispatch") { (requestId: String, status: String, message: String?) in
      MainActor.assumeIsolated {
        T3VoiceDispatchBridge.shared.resolveDispatch(requestId: requestId, status: status, message: message)
      }
    }.runOnQueue(.main)

    AsyncFunction("showPrompt") { (prompt: PromptRecord) in
      let shown = VoicePrompt(
        title: prompt.title,
        listening: prompt.listening,
        buttons: prompt.buttons.map {
          VoicePromptButton(id: $0.id, title: $0.title, systemImage: $0.systemImage)
        }
      )
      MainActor.assumeIsolated { T3VoiceDispatchBridge.shared.carPlayScreen?.showPrompt(shown) }
    }.runOnQueue(.main)

    AsyncFunction("speak") { (text: String) async throws in
      try await Self.speak(text)
    }

    AsyncFunction("stopSpeaking") {
      MainActor.assumeIsolated { T3VoiceDispatchBridge.shared.speaker.stop() }
    }.runOnQueue(.main)

    AsyncFunction("listen") { (request: ListenRecord) async throws -> [String: String] in
      try await Self.listen(request)
    }

    AsyncFunction("stopListening") { (buttonId: String, keepTranscript: Bool) in
      MainActor.assumeIsolated {
        if #available(iOS 26.0, *) {
          T3VoiceDispatchBridge.shared.listener.stop(
            buttonId: buttonId,
            keepTranscript: keepTranscript
          )
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("chooseProject") { (projects: [ProjectRecord]) async -> String? in
      await Self.chooseProject(projects)
    }

    AsyncFunction("endConversation") {
      VoiceAudioSession.deactivate()
    }.runOnQueue(.main)
  }

  @MainActor
  private static func speak(_ text: String) async throws {
    try await T3VoiceDispatchBridge.shared.speaker.speak(text)
  }

  @MainActor
  private static func listen(_ request: ListenRecord) async throws -> [String: String] {
    guard #available(iOS 26.0, *) else { throw VoiceAudioError.speechUnavailable }
    let outcome = try await T3VoiceDispatchBridge.shared.listener.listen(VoiceListenRequest(
      endSilence: .milliseconds(request.endSilenceMs),
      startTimeout: .milliseconds(request.startTimeoutMs),
      maxDuration: .milliseconds(request.maxDurationMs),
      hints: request.hints
    ))
    switch outcome {
    case let .speech(transcript):
      return ["type": "speech", "transcript": transcript]
    case .noSpeech:
      return ["type": "no-speech"]
    case let .button(buttonId):
      return ["type": "button", "buttonId": buttonId]
    }
  }

  @MainActor
  private static func chooseProject(_ projects: [ProjectRecord]) async -> String? {
    guard let screen = T3VoiceDispatchBridge.shared.carPlayScreen else { return nil }
    return await screen.chooseProject(projects.map {
      VoiceProjectChoice(key: $0.key, title: $0.title, subtitle: $0.subtitle)
    })
  }
}
