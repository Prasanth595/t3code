import CarPlay
import UIKit

struct VoicePromptButton: Equatable {
  let id: String
  let title: String
  let systemImage: String
}

struct VoicePrompt: Equatable {
  let title: String
  let listening: Bool
  let buttons: [VoicePromptButton]
}

struct VoiceProjectChoice {
  let key: String
  let title: String
  let subtitle: String?
}

/// The CarPlay screen of one connection: a voice control template that JS
/// drives through prompts, and a project list pushed on demand.
@MainActor
final class CarPlayVoiceScreen: NSObject, CPInterfaceControllerDelegate {
  private static let listeningStateId = "listening"
  private static let idleStateId = "idle"

  private let interfaceController: CPInterfaceController
  private let onButton: (String) -> Void
  private var shownPrompt: VoicePrompt?
  private var voiceTemplate: CPVoiceControlTemplate?
  private var projectList: CPListTemplate?
  private var projectChoice: CheckedContinuation<String?, Never>?

  init(interfaceController: CPInterfaceController, onButton: @escaping (String) -> Void) {
    self.interfaceController = interfaceController
    self.onButton = onButton
    super.init()
    interfaceController.delegate = self
  }

  func showStarting() {
    showPrompt(VoicePrompt(title: "Starting T3 Code…", listening: false, buttons: []))
  }

  func showUnavailable() {
    showPrompt(VoicePrompt(title: "Open T3 Code on your iPhone", listening: false, buttons: []))
  }

  /// Shows a prompt. Switching only between listening and idle keeps the
  /// template, so the screen does not flash between question and answer.
  func showPrompt(_ prompt: VoicePrompt) {
    defer { shownPrompt = prompt }
    if let voiceTemplate, let shownPrompt,
       shownPrompt.title == prompt.title, shownPrompt.buttons == prompt.buttons {
      voiceTemplate.activateVoiceControlState(
        withIdentifier: prompt.listening ? Self.listeningStateId : Self.idleStateId
      )
      return
    }
    let listening = makeState(Self.listeningStateId, prompt: prompt, image: Self.listeningImage())
    let idle = makeState(Self.idleStateId, prompt: prompt, image: UIImage(systemName: "waveform"))
    // The template opens on its first state.
    let template = CPVoiceControlTemplate(voiceControlStates: prompt.listening ? [listening, idle] : [idle, listening])
    voiceTemplate = template
    resolveProjectChoice(nil)
    interfaceController.setRootTemplate(template, animated: false, completion: nil)
  }

  /// Pushes a tappable project list; resolves with the chosen key, or nil
  /// when the driver backs out.
  func chooseProject(_ choices: [VoiceProjectChoice]) async -> String? {
    resolveProjectChoice(nil)
    let items = choices.prefix(CPListTemplate.maximumItemCount).map { choice in
      let item = CPListItem(text: choice.title, detailText: choice.subtitle)
      item.handler = { [weak self] _, completion in
        self?.resolveProjectChoice(choice.key)
        completion()
      }
      return item
    }
    let template = CPListTemplate(title: "Projects", sections: [CPListSection(items: Array(items))])
    projectList = template
    return await withCheckedContinuation { continuation in
      projectChoice = continuation
      interfaceController.pushTemplate(template, animated: true, completion: nil)
    }
  }

  func cancelPendingInteractions() {
    resolveProjectChoice(nil)
  }

  private func resolveProjectChoice(_ key: String?) {
    guard let continuation = projectChoice else { return }
    projectChoice = nil
    if let projectList, interfaceController.topTemplate === projectList {
      interfaceController.popTemplate(animated: true, completion: nil)
    }
    projectList = nil
    continuation.resume(returning: key)
  }

  private func makeState(_ id: String, prompt: VoicePrompt, image: UIImage?) -> CPVoiceControlState {
    let state = CPVoiceControlState(
      identifier: id,
      titleVariants: [prompt.title],
      image: image,
      repeats: id == Self.listeningStateId
    )
    if #available(iOS 26.4, *) {
      state.actionButtons = prompt.buttons
        .prefix(CPVoiceControlState.maximumActionButtonCount)
        .map { button in
          let action = CPButton(image: UIImage(systemName: button.systemImage) ?? UIImage()) { [weak self] _ in
            self?.onButton(button.id)
          }
          action.title = button.title
          return action
        }
    }
    return state
  }

  /// A waveform whose bars rise and fall while the microphone is live.
  private static func listeningImage() -> UIImage? {
    let frames = [0.2, 0.5, 0.8, 1.0, 0.8, 0.5].compactMap { level in
      UIImage(systemName: "waveform", variableValue: level)
    }
    return UIImage.animatedImage(with: frames, duration: 1.2)
  }

  // MARK: CPInterfaceControllerDelegate

  nonisolated func templateDidDisappear(_ aTemplate: CPTemplate, animated: Bool) {
    MainActor.assumeIsolated {
      // Backing out of the project list answers "none".
      if let projectList, aTemplate === projectList {
        self.projectList = nil
        if let continuation = projectChoice {
          projectChoice = nil
          continuation.resume(returning: nil)
        }
      }
    }
  }
}
