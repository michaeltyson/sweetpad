import * as vscode from "vscode";
import type { BuildTreeItem } from "../build/tree";
import { askXcodeWorkspacePath } from "../build/utils";
import { showConfigurationPicker, showYesNoQuestion } from "../common/askers";
import { getBuildConfigurations } from "../common/cli/scripts";
import type { ExtensionContext } from "../common/commands";
import { updateWorkspaceConfig } from "../common/config";
import { showInputBox } from "../common/quick-pick";
import { askSchemeForTesting, askTestingTarget } from "./utils";

export async function debugWithoutBuildingCommand(
  context: ExtensionContext,
  ...items: vscode.TestItem[]
): Promise<void> {
  context.updateProgressStatus("Debugging tests without building (macOS)");
  const request = new vscode.TestRunRequest(items, [], undefined, undefined);
  const tokenSource = new vscode.CancellationTokenSource();
  await (context.testingManager as any).debugTestsMacOSWithoutBuilding(request, tokenSource.token);
}

export async function selectTestingTargetCommand(context: ExtensionContext): Promise<void> {
  context.updateProgressStatus("Searching for workspace");
  const xcworkspace = await askXcodeWorkspacePath(context);

  context.updateProgressStatus("Selecting testing target");
  await askTestingTarget(context, {
    title: "Select default testing target",
    xcworkspace: xcworkspace,
    force: true,
  });
}

export async function buildForTestingCommand(context: ExtensionContext): Promise<void> {
  context.updateProgressStatus("Building for testing");
  return await context.testingManager.buildForTestingCommand(context);
}

export async function testWithoutBuildingCommand(
  context: ExtensionContext,
  ...items: vscode.TestItem[]
): Promise<void> {
  context.updateProgressStatus("Running tests without building");
  const request = new vscode.TestRunRequest(items, [], undefined, undefined);
  const tokenSource = new vscode.CancellationTokenSource();
  await context.testingManager.runTestsWithoutBuilding(request, tokenSource.token);
}

export async function runWithoutBuildingCommand(
  context: ExtensionContext,
  ...items: vscode.TestItem[]
): Promise<void> {
  // Same as testWithoutBuildingCommand but with a different name for clarity
  await testWithoutBuildingCommand(context, ...items);
}

/**
 * Force re-scan of the workspace to refresh discovered tests
 */
export async function refreshTestsCommand(context: ExtensionContext): Promise<void> {
  context.updateProgressStatus("Refreshing discovered tests");
  await context.testingManager.refreshAllTests();
}

/**
 * Run all discovered tests (without manual selection)
 */
export async function runAllTestsCommand(context: ExtensionContext): Promise<void> {
  context.updateProgressStatus("Running all discovered tests");
  const request = new vscode.TestRunRequest(undefined, [], undefined, undefined);
  const tokenSource = new vscode.CancellationTokenSource();
  await context.testingManager.buildAndRunTests(request, tokenSource.token);
}

/**
 * Quick pick to run a test by name (Class or Class.method)
 */
export async function runTestByNameCommand(context: ExtensionContext): Promise<void> {
  context.updateProgressStatus("Searching tests by name");

  const items: { label: string; item: vscode.TestItem }[] = [];
  for (const [, root] of context.testingManager.controller.items) {
    items.push({ label: root.id, item: root });
    for (const [, child] of root.children) {
      items.push({ label: child.id, item: child });
    }
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage("No tests discovered.");
    return;
  }

  const selected = await vscode.window.showQuickPick(items.map((i) => i.label), { placeHolder: "Run Test by Name" });
  if (!selected) return;
  const match = items.find((i) => i.label === selected);
  if (!match) return;

  const request = new vscode.TestRunRequest([match.item], [], undefined, undefined);
  const tokenSource = new vscode.CancellationTokenSource();
  await context.testingManager.buildAndRunTests(request, tokenSource.token);
}

/**
 * Debug currently selected tests via the Debug test profile (macOS)
 */
export async function debugSelectedTestsCommand(
  context: ExtensionContext,
  ...items: vscode.TestItem[]
): Promise<void> {
  context.updateProgressStatus("Debugging selected tests (macOS)");
  const request = new vscode.TestRunRequest(items, [], undefined, undefined);
  // Use TestController's Debug profile by name
  const debugProfile = context.testingManager.controller.createRunProfile(
    "__temp__",
    vscode.TestRunProfileKind.Debug,
    async () => {},
  );
  try {
    await (context.testingManager as any).debugTestsMacOS(request, new vscode.CancellationTokenSource().token);
  } finally {
    debugProfile.dispose();
  }
}

export async function selectXcodeSchemeForTestingCommand(context: ExtensionContext, item?: BuildTreeItem) {
  context.updateProgressStatus("Selecting scheme for testing");

  if (item) {
    item.provider.buildManager.setDefaultSchemeForTesting(item.scheme);
    return;
  }

  const xcworkspace = await askXcodeWorkspacePath(context);
  await askSchemeForTesting(context, {
    title: "Select scheme to set as default",
    xcworkspace: xcworkspace,
    ignoreCache: true,
  });
}

/**
 * Ask user to select configuration for testing
 */
export async function selectConfigurationForTestingCommand(context: ExtensionContext): Promise<void> {
  context.updateProgressStatus("Searching for workspace");
  const xcworkspace = await askXcodeWorkspacePath(context);

  context.updateProgressStatus("Searching for configurations");
  const configurations = await getBuildConfigurations({
    xcworkspace: xcworkspace,
  });

  let selected: string | undefined;
  if (configurations.length === 0) {
    selected = await showInputBox({
      title: "No configurations found. Please enter configuration name manually",
    });
  } else {
    selected = await showConfigurationPicker(configurations);
  }

  if (!selected) {
    vscode.window.showErrorMessage("Configuration was not selected");
    return;
  }

  const saveAnswer = await showYesNoQuestion({
    title: "Do you want to update configuration in the workspace settings (.vscode/settings.json)?",
  });
  if (saveAnswer) {
    await updateWorkspaceConfig("testing.configuration", selected);
    context.buildManager.setDefaultConfigurationForTesting(undefined);
  } else {
    context.buildManager.setDefaultConfigurationForTesting(selected);
  }
}
