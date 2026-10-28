"use strict";

const TARGET_NAME = "T3WatchCompanion";
const SOURCE_FILES = [
  "T3WatchApp.swift",
  "WatchModel.swift",
  "WatchViews.swift",
  "WatchContract.swift",
  "RecordingStore.swift",
];
const unquote = (value) => String(value ?? "").replace(/^"|"$/g, "");
const quote = (value) => JSON.stringify(value);

function addWatchCompanionTarget(project, bundleIdentifier, versions = {}) {
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleIdentifier ?? "")) {
    throw new Error("withWatchCompanion requires a concrete ios.bundleIdentifier");
  }
  const objects = project.hash.project.objects;
  const entries = (section) =>
    Object.entries(objects[section] ?? {}).filter(([, value]) => value?.isa);
  const add = (section, value, comment) => {
    objects[section] ??= {};
    const id = project.generateUuid();
    objects[section][id] = { isa: section, ...value };
    objects[section][`${id}_comment`] = comment;
    return id;
  };
  const root = entries("PBXProject")[0];
  if (!root) throw new Error("Xcode project is missing PBXProject");
  const configurations = (target) => {
    const list = objects.XCConfigurationList[target.buildConfigurationList];
    return (list?.buildConfigurations ?? []).map(
      ({ value }) => objects.XCBuildConfiguration[value],
    );
  };
  const host = entries("PBXNativeTarget").find(
    ([, target]) =>
      unquote(target.productType) === "com.apple.product-type.application" &&
      unquote(target.name) !== TARGET_NAME &&
      configurations(target).some(
        (config) => unquote(config.buildSettings.SDKROOT || "iphoneos") === "iphoneos",
      ),
  );
  if (!host) throw new Error("withWatchCompanion could not find the companion iOS app target");
  const [hostId, hostTarget] = host;
  let target = entries("PBXNativeTarget").find(([, value]) => unquote(value.name) === TARGET_NAME);
  if (!target) {
    const productId = add(
      "PBXFileReference",
      {
        explicitFileType: "wrapper.application",
        includeInIndex: 0,
        path: `${TARGET_NAME}.app`,
        sourceTree: "BUILT_PRODUCTS_DIR",
      },
      `${TARGET_NAME}.app`,
    );
    const productsId =
      root[1].productRefGroup ??
      entries("PBXGroup").find(([, value]) => unquote(value.name) === "Products")?.[0];
    if (!productsId) throw new Error("Xcode project is missing Products group");
    objects.PBXGroup[productsId].children.push({ value: productId, comment: `${TARGET_NAME}.app` });
    const groupId = add(
      "PBXGroup",
      { children: [], path: TARGET_NAME, sourceTree: '"<group>"' },
      TARGET_NAME,
    );
    objects.PBXGroup[root[1].mainGroup].children.push({ value: groupId, comment: TARGET_NAME });
    const sources = SOURCE_FILES.map((name) => {
      const fileId = add(
        "PBXFileReference",
        { lastKnownFileType: "sourcecode.swift", path: name, sourceTree: '"<group>"' },
        name,
      );
      objects.PBXGroup[groupId].children.push({ value: fileId, comment: name });
      return {
        value: add(
          "PBXBuildFile",
          { fileRef: fileId, fileRef_comment: name },
          `${name} in Sources`,
        ),
        comment: `${name} in Sources`,
      };
    });
    const plistId = add(
      "PBXFileReference",
      { lastKnownFileType: "text.plist.xml", path: "Info.plist", sourceTree: '"<group>"' },
      "Info.plist",
    );
    objects.PBXGroup[groupId].children.push({ value: plistId, comment: "Info.plist" });
    const sourcesId = add(
      "PBXSourcesBuildPhase",
      { buildActionMask: 2147483647, files: sources, runOnlyForDeploymentPostprocessing: 0 },
      "Sources",
    );
    const frameworksId = add(
      "PBXFrameworksBuildPhase",
      { buildActionMask: 2147483647, files: [], runOnlyForDeploymentPostprocessing: 0 },
      "Frameworks",
    );
    const configListId = add(
      "XCConfigurationList",
      {
        buildConfigurations: [],
        defaultConfigurationIsVisible: 0,
        defaultConfigurationName: "Release",
      },
      `Build configuration list for PBXNativeTarget "${TARGET_NAME}"`,
    );
    const targetId = add(
      "PBXNativeTarget",
      {
        buildConfigurationList: configListId,
        buildPhases: [
          { value: sourcesId, comment: "Sources" },
          { value: frameworksId, comment: "Frameworks" },
        ],
        buildRules: [],
        dependencies: [],
        name: TARGET_NAME,
        productName: TARGET_NAME,
        productReference: productId,
        productType: '"com.apple.product-type.application"',
      },
      TARGET_NAME,
    );
    root[1].targets.push({ value: targetId, comment: TARGET_NAME });
    const proxyId = add(
      "PBXContainerItemProxy",
      {
        containerPortal: root[0],
        proxyType: 1,
        remoteGlobalIDString: targetId,
        remoteInfo: TARGET_NAME,
      },
      "PBXContainerItemProxy",
    );
    const dependencyId = add(
      "PBXTargetDependency",
      { target: targetId, targetProxy: proxyId },
      "PBXTargetDependency",
    );
    hostTarget.dependencies ??= [];
    hostTarget.dependencies.push({ value: dependencyId, comment: "PBXTargetDependency" });
    const embedFileId = add(
      "PBXBuildFile",
      { fileRef: productId, settings: { ATTRIBUTES: ["RemoveHeadersOnCopy"] } },
      `${TARGET_NAME}.app in Embed Watch Content`,
    );
    const embedId = add(
      "PBXCopyFilesBuildPhase",
      {
        buildActionMask: 2147483647,
        dstPath: '"$(CONTENTS_FOLDER_PATH)/Watch"',
        dstSubfolderSpec: 16,
        files: [{ value: embedFileId, comment: `${TARGET_NAME}.app in Embed Watch Content` }],
        name: '"Embed Watch Content"',
        runOnlyForDeploymentPostprocessing: 0,
      },
      "Embed Watch Content",
    );
    hostTarget.buildPhases.push({ value: embedId, comment: "Embed Watch Content" });
    target = [targetId, objects.PBXNativeTarget[targetId]];
  }
  const [targetId, watchTarget] = target;
  if (unquote(watchTarget.productType) !== "com.apple.product-type.application") {
    throw new Error("T3WatchCompanion already exists with an incompatible target type");
  }
  const watchGroup = entries("PBXGroup").find(
    ([, group]) => unquote(group.path) === TARGET_NAME,
  )?.[1];
  if (!watchGroup) throw new Error("Watch target is missing its source group");
  let assetId = watchGroup.children.find(
    ({ value }) => unquote(objects.PBXFileReference[value]?.path) === "Assets.xcassets",
  )?.value;
  if (!assetId) {
    assetId = add(
      "PBXFileReference",
      {
        lastKnownFileType: "folder.assetcatalog",
        path: "Assets.xcassets",
        sourceTree: '"<group>"',
      },
      "Assets.xcassets",
    );
    watchGroup.children.push({ value: assetId, comment: "Assets.xcassets" });
  }
  let resourcesId = watchTarget.buildPhases.find(
    ({ value }) => objects.PBXResourcesBuildPhase?.[value],
  )?.value;
  if (!resourcesId) {
    resourcesId = add(
      "PBXResourcesBuildPhase",
      { buildActionMask: 2147483647, files: [], runOnlyForDeploymentPostprocessing: 0 },
      "Resources",
    );
    watchTarget.buildPhases.push({ value: resourcesId, comment: "Resources" });
  }
  const resources = objects.PBXResourcesBuildPhase[resourcesId];
  if (!resources.files.some(({ value }) => objects.PBXBuildFile[value]?.fileRef === assetId)) {
    const buildId = add(
      "PBXBuildFile",
      { fileRef: assetId, fileRef_comment: "Assets.xcassets" },
      "Assets.xcassets in Resources",
    );
    resources.files.push({ value: buildId, comment: "Assets.xcassets in Resources" });
  }
  const list = objects.XCConfigurationList[watchTarget.buildConfigurationList];
  for (const hostConfig of configurations(hostTarget)) {
    let config = configurations(watchTarget).find((value) => value.name === hostConfig.name);
    if (!config) {
      const id = add(
        "XCBuildConfiguration",
        { name: hostConfig.name, buildSettings: {} },
        unquote(hostConfig.name),
      );
      list.buildConfigurations.push({ value: id, comment: unquote(hostConfig.name) });
      config = objects.XCBuildConfiguration[id];
    }
    const settings = config.buildSettings;
    for (const key of ["DEVELOPMENT_TEAM", "CODE_SIGN_STYLE", "CODE_SIGN_IDENTITY"]) {
      if (hostConfig.buildSettings[key] !== undefined)
        settings[key] = hostConfig.buildSettings[key];
      else delete settings[key];
    }
    Object.assign(settings, {
      ARCHS: '"$(ARCHS_STANDARD)"',
      SDKROOT: "watchos",
      SUPPORTED_PLATFORMS: '"watchos watchsimulator"',
      TARGETED_DEVICE_FAMILY: "4",
      WATCHOS_DEPLOYMENT_TARGET: "10.0",
      SWIFT_VERSION: "5.0",
      SWIFT_STRICT_CONCURRENCY: "minimal",
      SWIFT_EMIT_LOC_STRINGS: "YES",
      ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon",
      MARKETING_VERSION:
        hostConfig.buildSettings.MARKETING_VERSION ?? quote(versions.version ?? "1.0"),
      CURRENT_PROJECT_VERSION:
        hostConfig.buildSettings.CURRENT_PROJECT_VERSION ?? quote(versions.buildNumber ?? "1"),
      PRODUCT_BUNDLE_IDENTIFIER: quote(`${bundleIdentifier}.watchkitapp`),
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      INFOPLIST_FILE: `${TARGET_NAME}/Info.plist`,
      GENERATE_INFOPLIST_FILE: "NO",
      SKIP_INSTALL: "YES",
      LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks"',
      ENABLE_USER_SCRIPT_SANDBOXING: "YES",
      SWIFT_OPTIMIZATION_LEVEL: unquote(hostConfig.name) === "Debug" ? '"-Onone"' : '"-O"',
    });
    delete settings.IPHONEOS_DEPLOYMENT_TARGET;
    delete settings.VALID_ARCHS;
    delete settings.EXCLUDED_ARCHS;
  }
  root[1].attributes ??= {};
  root[1].attributes.TargetAttributes ??= {};
  const hostAttributes = root[1].attributes.TargetAttributes[hostId] ?? {};
  const targetAttributes = (root[1].attributes.TargetAttributes[targetId] ??= {});
  for (const key of ["DevelopmentTeam", "ProvisioningStyle"]) {
    if (hostAttributes[key] !== undefined) targetAttributes[key] = hostAttributes[key];
    else delete targetAttributes[key];
  }
  return targetId;
}

module.exports = { addWatchCompanionTarget, SOURCE_FILES, TARGET_NAME };
