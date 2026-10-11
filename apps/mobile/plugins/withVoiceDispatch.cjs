"use strict";

// Hands-free dispatch: a CarPlay voice scene and Siri's "Start a thread"
// intent, both backed by modules/t3-voice-dispatch.
//
// - Declares the CarPlay scene next to the template's phone scene.
// - Copies voice-dispatch/T3VoiceDispatchAppSupport.swift into the app
//   target. Siri only discovers App Intents compiled into the app, and the
//   file starts React Native through the app delegate's factory.
// - Lets the template SceneDelegate adopt a React Native app that CarPlay or
//   Siri started before the phone screen existed, instead of starting a
//   second one.
// - Adds the CarPlay voice-based conversation entitlement only when asked:
//   device builds fail to sign until Apple grants it to the signing team,
//   while the simulator accepts it without a grant.

const fs = require("node:fs");
const path = require("node:path");
const {
  IOSConfig,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");

const SUPPORT_FILE = "T3VoiceDispatchAppSupport.swift";
const CARPLAY_SCENE_ROLE = "CPTemplateApplicationSceneSessionRoleApplication";
const CARPLAY_ENTITLEMENT = "com.apple.developer.carplay-voice-based-conversation";

const SCENE_DELEGATE_ANCHOR = "  // Extension point for config plugins.\n";
const SCENE_DELEGATE_MARKER =
  "  // t3code: adopt a React Native app that CarPlay or Siri started.\n";
const SCENE_DELEGATE_ADOPTION = `${SCENE_DELEGATE_MARKER}  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    // CarPlay or Siri may have started the app before this screen existed.
    guard let windowScene = scene as? UIWindowScene,
          let window = T3VoiceDispatchAppSupport.adoptHeadlessApp(in: windowScene) else {
      super.scene(scene, willConnectTo: session, options: connectionOptions)
      return
    }
    self.window = window
    self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    connectionOptions.userActivities.forEach { self.scene(scene, continue: $0) }
    if let shortcutItem = connectionOptions.shortcutItem {
      self.windowScene(windowScene, performActionFor: shortcutItem) { _ in }
    }
  }
`;

function withCarPlayScene(config) {
  return withInfoPlist(config, (mod) => {
    const configurations = mod.modResults.UIApplicationSceneManifest?.UISceneConfigurations;
    if (!configurations) {
      throw new Error("withVoiceDispatch: the template's UIApplicationSceneManifest is missing.");
    }
    configurations[CARPLAY_SCENE_ROLE] = [
      {
        UISceneClassName: "CPTemplateApplicationScene",
        UISceneConfigurationName: "CarPlay",
        UISceneDelegateClassName: "T3CarPlaySceneDelegate",
      },
    ];
    return mod;
  });
}

function withCarPlayEntitlement(config) {
  return withEntitlementsPlist(config, (mod) => {
    mod.modResults[CARPLAY_ENTITLEMENT] = true;
    return mod;
  });
}

function withAppSupportSources(config) {
  return withDangerousMod(config, [
    "ios",
    (mod) => {
      const projectName = IOSConfig.XcodeUtils.getProjectName(mod.modRequest.projectRoot);
      const appDir = path.join(mod.modRequest.platformProjectRoot, projectName);
      fs.copyFileSync(
        path.join(__dirname, "voice-dispatch", SUPPORT_FILE),
        path.join(appDir, SUPPORT_FILE),
      );

      const sceneDelegatePath = path.join(appDir, "SceneDelegate.swift");
      const sceneDelegate = fs.readFileSync(sceneDelegatePath, "utf8");
      if (sceneDelegate.includes(SCENE_DELEGATE_MARKER)) {
        return mod;
      }
      if (!sceneDelegate.includes(SCENE_DELEGATE_ANCHOR)) {
        throw new Error(
          "withVoiceDispatch: SceneDelegate.swift lost its config-plugin extension point.",
        );
      }
      fs.writeFileSync(
        sceneDelegatePath,
        `import UIKit\n${sceneDelegate.replace(
          SCENE_DELEGATE_ANCHOR,
          `${SCENE_DELEGATE_ANCHOR}${SCENE_DELEGATE_ADOPTION}`,
        )}`,
      );
      return mod;
    },
  ]);
}

function withAppSupportTarget(config) {
  return withXcodeProject(config, (mod) => {
    const projectName = IOSConfig.XcodeUtils.getProjectName(mod.modRequest.projectRoot);
    const filepath = `${projectName}/${SUPPORT_FILE}`;
    if (!mod.modResults.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName: projectName,
        project: mod.modResults,
      });
    }
    return mod;
  });
}

module.exports = function withVoiceDispatch(config, { carPlayEntitlement = false } = {}) {
  config = withCarPlayScene(config);
  config = withAppSupportSources(config);
  config = withAppSupportTarget(config);
  return carPlayEntitlement ? withCarPlayEntitlement(config) : config;
};
