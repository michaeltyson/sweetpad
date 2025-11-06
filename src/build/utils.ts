import path from "node:path";
import * as vscode from "vscode";
import { type QuickPickItem, showQuickPick } from "../common/quick-pick";

import { askConfigurationBase } from "../common/askers";
import { getBuildSettingsToAskDestination, getSchemes, XcodeBuildSettings, type XcodeBuildSettings as XcodeBuildSettingsType } from "../common/cli/scripts";
import type { ExtensionContext } from "../common/commands";
import { getWorkspaceConfig } from "../common/config";
import { ExtensionError } from "../common/errors";
import { createDirectory, findFilesRecursive, isFileExists, removeDirectory } from "../common/files";
import { commonLogger } from "../common/logger";
import { SUPPORTED_DESTINATION_PLATFORMS, type DestinationPlatform } from "../destination/constants";
import type { Destination } from "../destination/types";
import { splitSupportedDestinatinos } from "../destination/utils";
import type { SimulatorDestination } from "../simulators/types";

export type SelectedDestination = {
  type: "simulator" | "device";
  udid: string;
  name?: string;
};

/**
 * Ask user to select one of the Booted/Shutdown simulators
 */
export async function askSimulator(
  context: ExtensionContext,
  options: {
    title: string;
    state: "Booted" | "Shutdown";
    error: string;
  },
): Promise<SimulatorDestination> {
  let simulators = await context.destinationsManager.getSimulators({
    sort: true,
  });

  if (options?.state) {
    simulators = simulators.filter((simulator) => simulator.state === options.state);
  }

  if (simulators.length === 0) {
    throw new ExtensionError(options.error);
  }
  if (simulators.length === 1) {
    return simulators[0];
  }

  const selected = await showQuickPick({
    title: options.title,
    items: simulators.map((simulator) => {
      return {
        label: simulator.label,
        context: {
          simulator: simulator,
        },
      };
    }),
  });

  return selected.context.simulator;
}

/**
 * Generate a cache key for build settings based on the options
 *
 * @param options - Build settings options including scheme, configuration, SDK, and workspace path
 * @returns A unique cache key string for the given build settings combination
 */
export function getBuildSettingsCacheKey(options: {
  scheme: string;
  configuration: string;
  sdk: string | undefined;
  xcworkspace: string;
}): string {
  const normalizedWorkspace = path.normalize(options.xcworkspace);
  const workspacePath = getWorkspacePath();
  const relativeWorkspace = path.relative(workspacePath, normalizedWorkspace);
  return `${options.scheme}:${options.configuration}:${options.sdk ?? "default"}:${relativeWorkspace}`;
}

/**
 * Get cached build settings from workspace state
 *
 * @param context - Extension context for accessing workspace state
 * @param cacheKey - The cache key to look up
 * @returns Cached build settings if found and valid, null otherwise
 */
export function getCachedBuildSettings(
  context: ExtensionContext,
  cacheKey: string,
): XcodeBuildSettingsType | null {
  const cached = context.getWorkspaceState("build.xcodeBuildSettingsCache");
  if (!cached || typeof cached !== "string") {
    return null;
  }

  try {
    const cacheData = JSON.parse(cached);
    if (cacheData.key === cacheKey && cacheData.settingsData && cacheData.target) {
      // Reconstruct the XcodeBuildSettings class instance from cached data
      commonLogger.log("Build settings cache HIT", { cacheKey });
      return new XcodeBuildSettings({
        settings: cacheData.settingsData,
        target: cacheData.target,
      });
    }
  } catch (e) {
    commonLogger.warn("Failed to parse cached build settings", { error: e, cacheKey });
  }

  return null;
}

/**
 * Cache build settings in workspace state
 *
 * Serializes the build settings and stores them in workspace state for future use.
 * The settings are stored with the provided cache key for later retrieval.
 *
 * @param context - Extension context for accessing workspace state
 * @param cacheKey - The cache key to use for storage
 * @param settings - The build settings to cache
 */
export async function cacheBuildSettings(
  context: ExtensionContext,
  cacheKey: string,
  settings: XcodeBuildSettingsType,
): Promise<void> {
  try {
    // Access the private settings property to store the raw data
    // We'll reconstruct the XcodeBuildSettings instance when retrieving from cache
    const settingsData = (settings as any).settings;
    if (!settingsData) {
      commonLogger.warn("Cannot cache build settings: settings data is missing", { cacheKey });
      return;
    }
    const cacheData = JSON.stringify({
      key: cacheKey,
      settingsData: settingsData,
      target: settings.target,
    });
    await context.updateWorkspaceState("build.xcodeBuildSettingsCache", cacheData);
  } catch (e) {
    commonLogger.warn("Failed to cache build settings", { error: e, cacheKey });
  }
}

/**
 * Ask user to select simulator or device to run on
 */
export async function askDestinationToRunOn(
  context: ExtensionContext,
  options: {
    scheme: string;
    configuration: string;
    sdk: string | undefined;
    xcworkspace: string;
  },
): Promise<{ destination: Destination; buildSettings: XcodeBuildSettings | null }> {
  context.updateProgressStatus("Searching for destinations");
  const destinations = await context.destinationsManager.getDestinations({
    mostUsedSort: true,
  });

  // Check if we have cached build settings for any SDK for this scheme/config
  // This avoids fetching when we just need to check supported platforms
  let buildSettings: XcodeBuildSettings | null = null;
  if (options.sdk === undefined) {
    // Try to find cached settings for any SDK - we'll use the first one we find
    // This is a heuristic: if we have cached settings for any SDK, the supported platforms are likely the same
    // Note: SDK strings match DestinationPlatform values
    for (const sdk of SUPPORTED_DESTINATION_PLATFORMS) {
      const testCacheKey = getBuildSettingsCacheKey({
        scheme: options.scheme,
        configuration: options.configuration,
        sdk: sdk,
        xcworkspace: options.xcworkspace,
      });
      const cached = getCachedBuildSettings(context, testCacheKey);
      if (cached) {
        buildSettings = cached;
        break;
      }
    }
  }

  // If we have cached destination, use it
  const cachedDestination = context.destinationsManager.getSelectedXcodeDestinationForBuild();
  if (cachedDestination) {
    const destination = destinations.find(
      (destination) => destination.id === cachedDestination.id && destination.type === cachedDestination.type,
    );
    if (destination) {
      // Only fetch if we don't have cached settings to check supported platforms
      if (!buildSettings) {
        context.updateProgressStatus("Checking supported platforms");
        buildSettings = await getBuildSettingsToAskDestination(
          {
            scheme: options.scheme,
            configuration: options.configuration,
            sdk: options.sdk,
            xcworkspace: options.xcworkspace,
          },
          (message) => context.updateProgressStatus(message),
        );
      }
      return { destination, buildSettings: null }; // Don't return buildSettings here - cache will be done later
    }
  }

  // We can remove platforms that are not supported by the build settings
  // WARNING: if want to avoid refetching build settings, move this logic to build manager or build context (not exist yet)
  if (!buildSettings) {
    context.updateProgressStatus("Checking supported platforms");
    buildSettings = await getBuildSettingsToAskDestination(
      {
        scheme: options.scheme,
        configuration: options.configuration,
        sdk: options.sdk,
        xcworkspace: options.xcworkspace,
      },
      (message) => context.updateProgressStatus(message),
    );
  }
  const supportedPlatforms = buildSettings?.supportedPlatforms;

  const destination = await selectDestinationForBuild(context, {
    destinations: destinations,
    supportedPlatforms: supportedPlatforms,
  });

  return { destination, buildSettings };
}

export async function selectDestinationForBuild(
  context: ExtensionContext,
  options: {
    destinations: Destination[];
    supportedPlatforms: DestinationPlatform[] | undefined;
  },
): Promise<Destination> {
  const { supported, unsupported } = splitSupportedDestinatinos({
    destinations: options.destinations,
    supportedPlatforms: options.supportedPlatforms,
  });

  const supportedItems: QuickPickItem<Destination>[] = supported.map((destination) => ({
    label: destination.name,
    iconPath: new vscode.ThemeIcon(destination.icon),
    detail: destination.quickPickDetails,
    context: destination,
  }));
  const unsupportedItems: QuickPickItem<Destination>[] = unsupported.map((destination) => ({
    label: destination.name,
    iconPath: new vscode.ThemeIcon(destination.icon),
    detail: destination.quickPickDetails,
    context: destination,
  }));

  const items: QuickPickItem<Destination>[] = [];
  if (unsupported.length === 0 && supported.length === 0) {
    // Show that no destinations found
    items.push({
      label: "No destinations found",
      kind: vscode.QuickPickItemKind.Separator,
    });
  } else if (supported.length > 0 && unsupported.length > 0) {
    // Split supported and unsupported destinations
    items.push({
      label: "Supported platforms",
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push(...supportedItems);
    items.push({
      label: "Other",
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push(...unsupportedItems);
  } else {
    // Just make flat list, one is empty and another is not
    items.push(...supportedItems);
    items.push(...unsupportedItems);
  }

  const selected = await showQuickPick<Destination>({
    title: "Select destination to run on",
    items: items,
  });

  const destination = selected.context;

  context.destinationsManager.setWorkspaceDestinationForBuild(destination);
  return destination;
}

/**
 * Ask user to select scheme to build
 */
export async function askSchemeForBuild(
  context: ExtensionContext,
  options: {
    title?: string;
    xcworkspace: string;
    ignoreCache?: boolean;
  },
): Promise<string> {
  context.updateProgressStatus("Searching for scheme");

  const cachedScheme = context.buildManager.getDefaultSchemeForBuild();
  if (cachedScheme && !options.ignoreCache) {
    return cachedScheme;
  }

  const schemes = await getSchemes({
    xcworkspace: options.xcworkspace,
  });

  const scheme = await showQuickPick({
    title: options?.title ?? "Select scheme to build",
    items: schemes.map((scheme) => {
      return {
        label: scheme.name,
        context: {
          scheme: scheme,
        },
      };
    }),
  });

  const schemeName = scheme.context.scheme.name;
  context.buildManager.setDefaultSchemeForBuild(schemeName);
  return schemeName;
}

/**
 * It's absolute path to current opened workspace
 */
export function getWorkspacePath(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceFolder) {
    throw new ExtensionError("No workspace folder found");
  }
  return workspaceFolder;
}

/**
 * Prepare storage path for the extension. It's a folder where we store all intermediate files
 */
export async function prepareStoragePath(context: ExtensionContext): Promise<string> {
  const storagePath = context.storageUri?.fsPath;
  if (!storagePath) {
    throw new ExtensionError("No storage path found");
  }
  // Creatre folder at storagePath, because vscode doesn't create it automatically
  await createDirectory(storagePath);
  return storagePath;
}

/**
 * Prepare bundle directory for the given scheme in the storage path
 */
export async function prepareBundleDir(context: ExtensionContext, scheme: string): Promise<string> {
  const storagePath = await prepareStoragePath(context);

  const bundleDir = path.join(storagePath, "bundle", scheme);

  // Remove old bundle if exists
  await removeDirectory(bundleDir);

  // Remove old .xcresult if exists
  const xcresult = path.join(storagePath, "bundle", `${scheme}.xcresult`);
  await removeDirectory(xcresult);

  return bundleDir;
}

export function prepareDerivedDataPath(): string | null {
  const configPath = getWorkspaceConfig("build.derivedDataPath");

  // No config -> path will be provided by xcodebuild
  if (!configPath) {
    return null;
  }

  // Expand relative path to absolute
  let derivedDataPath: string = configPath;
  if (!path.isAbsolute(configPath)) {
    // Example: .biuld/ -> /Users/username/Projects/project/.build
    derivedDataPath = path.join(getWorkspacePath(), configPath);
  }

  return derivedDataPath;
}

export function getCurrentXcodeWorkspacePath(context: ExtensionContext): string | undefined {
  const configPath = getWorkspaceConfig("build.xcodeWorkspacePath");
  if (configPath) {
    context.updateWorkspaceState("build.xcodeWorkspacePath", undefined);
    if (path.isAbsolute(configPath)) {
      return configPath;
    }
    return path.join(getWorkspacePath(), configPath);
  }

  const cachedPath = context.getWorkspaceState("build.xcodeWorkspacePath");
  if (cachedPath) {
    return cachedPath;
  }

  return undefined;
}

export async function askXcodeWorkspacePath(context: ExtensionContext): Promise<string> {
  const current = getCurrentXcodeWorkspacePath(context);
  if (current) {
    return current;
  }

  const selectedPath = await selectXcodeWorkspace({
    autoselect: true,
  });

  context.updateWorkspaceState("build.xcodeWorkspacePath", selectedPath);
  context.buildManager.refreshSchemes();
  return selectedPath;
}

export async function askConfiguration(
  context: ExtensionContext,
  options: {
    xcworkspace: string;
  },
): Promise<string> {
  context.updateProgressStatus("Searching for build configuration");

  const fromConfig = getWorkspaceConfig("build.configuration");
  if (fromConfig) {
    return fromConfig;
  }
  const cached = context.buildManager.getDefaultConfigurationForBuild();
  if (cached) {
    return cached;
  }
  const selected = await askConfigurationBase({
    xcworkspace: options.xcworkspace,
  });
  context.buildManager.setDefaultConfigurationForBuild(selected);
  return selected;
}

/**
 * Detect xcode workspace in the given directory
 */
export async function detectXcodeWorkspacesPaths(): Promise<string[]> {
  const workspace = getWorkspacePath();

  // Get all files that end with .xcworkspace (4 depth)
  const paths = await findFilesRecursive({
    directory: workspace,
    depth: 4,
    matcher: (file) => {
      return file.name.endsWith(".xcworkspace");
    },
  });
  return paths;
}

/**
 * Find xcode workspace in the given directory and ask user to select it
 */
export async function selectXcodeWorkspace(options: { autoselect: boolean }): Promise<string> {
  const workspacePath = getWorkspacePath();

  // Get all files that end with .xcworkspace (4 depth)
  const paths = await detectXcodeWorkspacesPaths();

  // No files, nothing to do
  if (paths.length === 0) {
    throw new ExtensionError("No xcode workspaces found", {
      context: {
        cwd: workspacePath,
      },
    });
  }

  // One file, use it and save it to the cache
  if (paths.length === 1 && options.autoselect) {
    const path = paths[0];
    commonLogger.log("Xcode workspace was detected", {
      workspace: workspacePath,
      path: path,
    });
    return path;
  }

  const podfilePath = path.join(workspacePath, "Podfile");
  const isCocoaProject = await isFileExists(podfilePath);

  // More then one, ask user to select
  const selected = await showQuickPick({
    title: "Select xcode workspace",
    items: paths
      .sort((a, b) => {
        // Sort by depth to show less nested paths first
        const aDepth = a.split(path.sep).length;
        const bDepth = b.split(path.sep).length;
        return aDepth - bDepth;
      })
      .map((xwPath) => {
        // show only relative path, to make it more readable
        const relativePath = path.relative(workspacePath, xwPath);
        const parentDir = path.dirname(relativePath);

        const isInRootDir = parentDir === ".";
        const isCocoaPods = isInRootDir && isCocoaProject;

        let detail: string | undefined;
        if (isCocoaPods && isInRootDir) {
          detail = "CocoaPods (recommended)";
        } else if (!isInRootDir && parentDir.endsWith(".xcodeproj")) {
          detail = "Xcode";
        }
        // todo: add workspace with multiple projects

        return {
          label: relativePath,
          detail: detail,
          context: {
            path: xwPath,
          },
        };
      }),
  });
  return selected.context.path;
}

export async function restartSwiftLSP() {
  // Restart SourceKit Language Server
  try {
    await vscode.commands.executeCommand("swift.restartLSPServer");
  } catch (error) {
    commonLogger.warn("Error restarting SourceKit Language Server", {
      error: error,
    });
  }
}
