import path from "node:path";
import * as vscode from "vscode";
import { getXcodeBuildDestinationString, isXcbeautifyEnabled } from "../build/commands.js";
import {
  askXcodeWorkspacePath,
  detectXcodeWorkspacesPaths,
  getCurrentXcodeWorkspacePath,
  getWorkspacePath,
  prepareDerivedDataPath,
} from "../build/utils.js";
import { getBuildSettingsToAskDestination, getIsXcbeautifyInstalled } from "../common/cli/scripts.js";
import type { ExtensionContext } from "../common/commands.js";
import { errorReporting } from "../common/error-reporting.js";
import { exec } from "../common/exec.js";
import { isFileExists } from "../common/files.js";
import { commonLogger } from "../common/logger.js";
import { runTask } from "../common/tasks.js";
import type { Destination } from "../destination/types.js";
import { askConfigurationForTesting, askDestinationToTestOn, askSchemeForTesting, askTestingTarget } from "./utils.js";

type TestingInlineError = {
  fileName: string;
  lineNumber: number;
  message: string;
};

/**
 * Track the result of each `xcodebuild` test run — which tests have been processed, failed and so on.
 *
 * - methodTestId: the test method ID in the format "ClassName.methodName"
 */
class XcodebuildTestRunContext {
  private processedMethodTests = new Set<string>();
  private failedMethodTests = new Set<string>();
  private inlineErrorMap = new Map<string, TestingInlineError>();
  private methodTests: Map<string, vscode.TestItem>;

  constructor(options: {
    methodTests: Iterable<[string, vscode.TestItem]>;
  }) {
    this.methodTests = new Map(options.methodTests);
  }

  getMethodTest(methodTestId: string): vscode.TestItem | undefined {
    return this.methodTests.get(methodTestId);
  }

  getMethodTests(): Iterable<[string, vscode.TestItem]> {
    return this.methodTests.entries();
  }

  addProcessedMethodTest(methodTestId: string): void {
    this.processedMethodTests.add(methodTestId);
  }

  addFailedMethodTest(methodTestId: string): void {
    this.failedMethodTests.add(methodTestId);
  }

  addInlineError(methodTestId: string, error: TestingInlineError): void {
    this.inlineErrorMap.set(methodTestId, error);
  }

  getInlineError(methodTestId: string): TestingInlineError | undefined {
    return this.inlineErrorMap.get(methodTestId);
  }

  isMethodTestProcessed(methodTestId: string): boolean {
    return this.processedMethodTests.has(methodTestId);
  }

  getUnprocessedMethodTests(): vscode.TestItem[] {
    return [...this.methodTests.entries()]
      .filter(([methodTestId]) => !this.processedMethodTests.has(methodTestId))
      .map(([, test]) => test);
  }

  getOverallStatus(): "passed" | "failed" | "skipped" {
    // Some tests failed
    if (this.failedMethodTests.size > 0) {
      return "failed";
    }

    // All tests passed
    if (this.processedMethodTests.size === this.methodTests.size) {
      return "passed";
    }

    // Some tests are still unprocessed
    return "skipped";
  }
}

/**
 * Extracts a code block from the given text starting from the given index.
 *
 * TODO: use a proper Swift parser to find code blocks
 */
function extractCodeBlock(text: string, startIndex: number): string | null {
  let braceCount = 0;
  let inString = false;
  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];
    if (char === '"' || char === "'") {
      inString = !inString;
    } else if (!inString) {
      if (char === "{") {
        braceCount++;
      } else if (char === "}") {
        braceCount--;
        if (braceCount === 0) {
          return text.substring(startIndex, i + 1);
        }
      }
    }
  }
  return null;
}

function buildLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function positionAt(options: { text: string; offsets?: number[] }, index: number): vscode.Position {
  if (index < 0) {
    return new vscode.Position(0, 0);
  }
  const offsets = options.offsets ?? buildLineOffsets(options.text);
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] <= index && (mid === offsets.length - 1 || offsets[mid + 1] > index)) {
      return new vscode.Position(mid, index - offsets[mid]);
    }
    if (offsets[mid] > index) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return new vscode.Position(0, index);
}

/**
 * Get all ancestor paths of a childPath that are within the parentPath (including the parentPath).
 */
function* getAncestorsPaths(options: {
  parentPath: string;
  childPath: string;
}): Generator<string> {
  const { parentPath, childPath } = options;

  if (!childPath.startsWith(parentPath)) {
    return;
  }

  let currentPath = path.dirname(childPath);
  while (currentPath !== parentPath) {
    yield currentPath;
    currentPath = path.dirname(currentPath);
  }
  yield parentPath;
}

/*
 * Custom data for test items
 */
type TestItemContext = {
  type: "scheme" | "class" | "method";
  scheme?: string;
  className?: string;
  methodName?: string;
  parentId?: string;
  spmTarget?: string;
  xcodeTarget?: string;
};

type ClassMethodInfo = {
  className: string;
  methodName?: string;
};

type SchemeInfo = {
  name: string;
  testTargets: string[];
};

type SchemeIndex = {
  workspacePath: string;
  workspace: import("../common/xcode/workspace.js").XcodeWorkspace;
  schemes: SchemeInfo[];
  targetToSchemes: Map<string, SchemeInfo[]>;
};

type DiscoveredTestMethod = {
  name: string;
  range: vscode.Range;
};

type DiscoveredTestClass = {
  name: string;
  range: vscode.Range;
  methods: DiscoveredTestMethod[];
};

const UNKNOWN_SCHEME_NAME = "Ungrouped Tests";

export class TestingManager {
  controller: vscode.TestController;
  private _context: ExtensionContext | undefined;
  private schemeIndex: SchemeIndex | null = null;
  private schemeIndexPromise: Promise<void> | null = null;
  private readonly schemeItems = new Map<string, vscode.TestItem>();
  private readonly fileTargetsCache = new Map<string, string[]>();

  // Inline error messages, usually is between "passed" and "failed" lines. Seems like only macOS apps have this line.
  // Example output:
  // "/Users/username/Projects/ControlRoom/ControlRoomTests/SimCtlSubCommandsTests.swift:10: error: -[ControlRoomTests.SimCtlSubCommandsTests testDeleteUnavailable] : failed: caught "NSInternalInconsistencyException", "Failed to delete unavailable device with UDID '00000000-0000-0000-0000-000000000000'."
  // "/Users/hyzyla/Developer/sweetpad-examples/ControlRoom/ControlRoomTests/Controllers/SimCtl+SubCommandsTests.swift:76: error: -[ControlRoomTests.SimCtlSubCommandsTests testDefaultsForApp] : XCTAssertEqual failed: ("1") is not equal to ("2")"
  // {filePath}:{lineNumber}: error: -[{classAndTargetName} {methodName}] : {errorMessage}
  readonly INLINE_ERROR_REGEXP = /(.*):(\d+): error: -\[.* (.*)\] : (.*)/;

  // Find test method status lines
  // Example output:
  // "Test Case '-[ControlRoomTests.SimCtlSubCommandsTests testDeleteUnavailable]' started."
  // "Test Case '-[ControlRoomTests.SimCtlSubCommandsTests testDeleteUnavailable]' passed (0.001 seconds)."
  // "Test Case '-[ControlRoomTests.SimCtlSubCommandsTests testDeleteUnavailable]' failed (0.001 seconds).")
  readonly METHOD_STATUS_REGEXP_MACOS = /Test Case '-\[(.*) (.*)\]' (.*)/;

  // "Test case 'terminal23TesMakarenko1ts.testExample1()' failed on 'Clone 1 of iPhone 14 - terminal23 (27767)' (0.154 seconds)"
  // "Test case 'terminal23TesMakarenko1ts.testExample2()' passed on 'Clone 1 of iPhone 14 - terminal23 (27767)' (0.000 seconds)"
  // "Test case 'terminal23TesMakarenko1ts.testPerformanceExample()' passed on 'Clone 1 of iPhone 14 - terminal23 (27767)' (0.254 seconds)"
  readonly METHOD_STATUS_REGEXP_IOS = /Test case '(.*)\.(.*)\(\)' (.*)/;

  // Here we are storign additional data for test items. Weak map garanties that we
  // don't keep the items in memory if they are not used anymore
  readonly testItems = new WeakMap<vscode.TestItem, TestItemContext>();

  // Root folder of the workspace (VSCode, not Xcode)
  readonly workspacePath: string;

  constructor() {
    this.workspacePath = getWorkspacePath();

    this.controller = vscode.tests.createTestController("sweetpad", "SweetPad");

    // Register event listeners for updating test items when documents change or open
    vscode.workspace.onDidOpenTextDocument((document) => {
      void this.updateTestItems(document);
    });
    vscode.workspace.onDidChangeTextDocument((event) => {
      void this.updateTestItems(event.document);
    });

    // Always perform a one-time discovery on startup so tests appear immediately
    void this.refreshAllTests();

    // Workspace-wide watchers: opt-in via setting to avoid heavy scanning in large repos
    const autoDiscover = vscode.workspace.getConfiguration("sweetpad").get<boolean>("testing.autoDiscover", true);
    if (autoDiscover) {
      // Watch only Tests folders for relevant file types
      const swiftWatcher = vscode.workspace.createFileSystemWatcher("**/*Tests*/**/*.swift");
      const mWatcher = vscode.workspace.createFileSystemWatcher("**/*Tests*/**/*.m");
      const mmWatcher = vscode.workspace.createFileSystemWatcher("**/*Tests*/**/*.mm");

      const onChange = (uri: vscode.Uri) => this.onWorkspaceFileChanged(uri);
      const onDelete = (uri: vscode.Uri) => this.onWorkspaceFileDeleted(uri);

      swiftWatcher.onDidCreate(onChange);
      swiftWatcher.onDidChange(onChange);
      swiftWatcher.onDidDelete(onDelete);
      mWatcher.onDidCreate(onChange);
      mWatcher.onDidChange(onChange);
      mWatcher.onDidDelete(onDelete);
      mmWatcher.onDidCreate(onChange);
      mmWatcher.onDidChange(onChange);
      mmWatcher.onDidDelete(onDelete);
    }

    // VS Code only supports 2 buttons per test (Run + Debug)
    this.createRunProfile({
      name: "Build and Run Tests",
      kind: vscode.TestRunProfileKind.Run,
      isDefault: true,
      run: (request, token) => this.buildAndRunTests(request, token),
    });

    this.createRunProfile({
      name: "Debug Tests (macOS)",
      kind: vscode.TestRunProfileKind.Debug,
      isDefault: true,
      run: (request, token) => this.debugTestsMacOS(request, token),
    });
  }

  private async resolveWorkspacePathForDiscovery(): Promise<string | null> {
    if (!this._context) {
      return null;
    }
    const cached = getCurrentXcodeWorkspacePath(this._context);
    if (cached) {
      return cached;
    }
    try {
      const detected = await detectXcodeWorkspacesPaths();
      if (detected.length === 1) {
        return detected[0];
      }
    } catch (error) {
      commonLogger.warn("Failed to detect xcode workspace", { error });
    }
    return null;
  }

  private async ensureSchemeIndex(): Promise<void> {
    const workspacePath = await this.resolveWorkspacePathForDiscovery();
    if (!workspacePath) {
      this.schemeIndex = null;
      return;
    }
    if (this.schemeIndex && this.schemeIndex.workspacePath === workspacePath) {
      return;
    }
    if (this.schemeIndexPromise) {
      await this.schemeIndexPromise;
      if (this.schemeIndex && this.schemeIndex.workspacePath === workspacePath) {
        return;
      }
    }
    this.schemeIndexPromise = this.loadSchemeIndex(workspacePath);
    await this.schemeIndexPromise;
  }

  private async loadSchemeIndex(workspacePath: string): Promise<void> {
    try {
      const { XcodeWorkspace } = await import("../common/xcode/workspace.js");
      const workspace = await XcodeWorkspace.parseWorkspace(workspacePath);
      const projects = await workspace.getProjects();
      const schemeMap = new Map<string, SchemeInfo>();

      for (const project of projects) {
        const schemes = await project.getSchemes();
        for (const scheme of schemes) {
          const testTargets = (await scheme.getTestableTargets()).filter((name) => !/UITests/i.test(name));
          if (testTargets.length === 0) {
            continue;
          }
          const existing = schemeMap.get(scheme.name);
          if (existing) {
            existing.testTargets = Array.from(new Set([...existing.testTargets, ...testTargets]));
          } else {
            schemeMap.set(scheme.name, {
              name: scheme.name,
              testTargets: testTargets,
            });
          }
        }
      }

      const targetToSchemes = new Map<string, SchemeInfo[]>();
      for (const info of schemeMap.values()) {
        for (const target of info.testTargets) {
          const arr = targetToSchemes.get(target) ?? [];
          arr.push(info);
          targetToSchemes.set(target, arr);
        }
      }

      this.schemeIndex = {
        workspacePath: workspacePath,
        workspace: workspace,
        schemes: [...schemeMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
        targetToSchemes: targetToSchemes,
      };
      this.fileTargetsCache.clear();
    } catch (error) {
      commonLogger.warn("Failed to build scheme index", { error: error });
      this.schemeIndex = null;
    } finally {
      this.schemeIndexPromise = null;
    }
  }

  private getSchemeItemId(name: string): string {
    return `scheme:${name}`;
  }

  private buildClassTestId(options: { scheme: string; uri: vscode.Uri; className: string }): string {
    const relative = path.relative(this.workspacePath, options.uri.fsPath);
    return `class:${options.scheme}:${relative}:${options.className}`;
  }

  private buildMethodTestId(options: { classId: string; methodName: string }): string {
    return `method:${options.classId}:${options.methodName}`;
  }

  private getOrCreateSchemeItem(name: string): vscode.TestItem {
    const key = name;
    const existing = this.schemeItems.get(key);
    if (existing) {
      return existing;
    }
    const item = this.controller.createTestItem(this.getSchemeItemId(name), name, undefined);
    this.testItems.set(item, {
      type: "scheme",
      scheme: name,
    });
    this.controller.items.add(item);
    this.schemeItems.set(key, item);
    return item;
  }

  private cleanupSchemeItem(item: vscode.TestItem) {
    if (item.children.size > 0) {
      return;
    }
    const ctx = this.testItems.get(item);
    if (!ctx?.scheme) {
      return;
    }
    this.controller.items.delete(item.id);
    this.schemeItems.delete(ctx.scheme);
  }

  private async resolveTargetsForFile(fsPath: string): Promise<string[] | null> {
    if (!this.schemeIndex) {
      return null;
    }
    const cached = this.fileTargetsCache.get(fsPath);
    if (cached) {
      return cached;
    }
    try {
      const targets = await this.schemeIndex.workspace.getTestTargetsForFile(fsPath);
      this.fileTargetsCache.set(fsPath, targets);
      return targets;
    } catch (error) {
      commonLogger.warn("Failed to resolve test targets for file", {
        error: error,
        file: fsPath,
      });
      return null;
    }
  }

  private async resolveSchemesForFile(fsPath: string): Promise<string[]> {
    await this.ensureSchemeIndex();
    if (!this.schemeIndex) {
      return [];
    }
    const targets = await this.resolveTargetsForFile(fsPath);
    if (!targets || targets.length === 0) {
      return [];
    }
    const schemes = new Set<string>();
    for (const target of targets) {
      const infos = this.schemeIndex.targetToSchemes.get(target) ?? [];
      for (const info of infos) {
        schemes.add(info.name);
      }
    }
    return [...schemes];
  }

  /**
   * Create run profile for the test controller with proper error handling
   */
  createRunProfile(options: {
    name: string;
    kind: vscode.TestRunProfileKind;
    isDefault?: boolean;
    run: (request: vscode.TestRunRequest, token: vscode.CancellationToken) => Promise<void>;
  }) {
    this.controller.createRunProfile(
      options.name,
      options.kind,
      async (request, token) => {
        try {
          return await options.run(request, token);
        } catch (error) {
          const errorMessage: string =
            error instanceof Error ? error.message : (error?.toString() ?? "[unknown error]");
          commonLogger.error(errorMessage, {
            error: error,
          });
          errorReporting.captureException(error);
          throw error;
        }
      },
      options.isDefault,
    );
  }

  set context(context: ExtensionContext) {
    this._context = context;
  }

  get context(): ExtensionContext {
    if (!this._context) {
      throw new Error("Context is not set");
    }
    return this._context;
  }

  dispose() {
    this.controller.dispose();
  }

  setDefaultTestingTarget(target: string | undefined) {
    this.context.updateWorkspaceState("testing.xcodeTarget", target);
  }

  getDefaultTestingTarget(): string | undefined {
    return this.context.getWorkspaceState("testing.xcodeTarget");
  }

  /**
   * Create a new test item for the given document with additional context data
   */
  createTestItem(options: {
    id: string;
    label: string;
    uri?: vscode.Uri;
    type: TestItemContext["type"];
    scheme?: string;
    className?: string;
    methodName?: string;
    parentId?: string;
  }): vscode.TestItem {
    const testItem = this.controller.createTestItem(options.id, options.label, options.uri);
    this.testItems.set(testItem, {
      type: options.type,
      scheme: options.scheme,
      className: options.className,
      methodName: options.methodName,
      parentId: options.parentId,
    });
    return testItem;
  }

  private getItemContext(item: vscode.TestItem): TestItemContext | undefined {
    return this.testItems.get(item);
  }

  private getClassMethodInfo(item: vscode.TestItem): ClassMethodInfo | null {
    const ctx = this.getItemContext(item);
    if (!ctx?.className) {
      return null;
    }
    return {
      className: ctx.className,
      methodName: ctx.methodName,
    };
  }

  private getMethodTestKey(item: vscode.TestItem): string | null {
    const info = this.getClassMethodInfo(item);
    if (!info || !info.methodName) {
      return null;
    }
    return `${info.className}.${info.methodName}`;
  }

  /**
   * Find all test methods in the given document and update the test items in test controller
   *
   * TODO: use a proper Swift parser to find test methods
   */
  async updateTestItems(document: vscode.TextDocument): Promise<void> {
    // Exclude UI Tests by path convention
    const filePathLower = document.fileName.toLowerCase();
    if (filePathLower.includes("uitests")) {
      return;
    }

    const isSwift = document.fileName.endsWith(".swift");
    const isObjC = document.fileName.endsWith(".m") || document.fileName.endsWith(".mm");
    if (!isSwift && !isObjC) {
      return;
    }

    const text = document.getText();

    let classes: DiscoveredTestClass[] = [];
    if (isSwift) {
      classes = this.parseSwiftTests({ text, document });
    } else if (isObjC) {
      classes = this.parseObjCTests({ text, document, uri: document.uri });
    }

    await this.applyDiscoveredTests(document.uri, classes);
  }

  /**
   * Parse Swift XCTestCase classes and methods in a document
   */
  private parseSwiftTests(options: { text: string; document?: vscode.TextDocument }): DiscoveredTestClass[] {
    const { text } = options;
    const offsets = options.document ? undefined : buildLineOffsets(text);
    const getPosition = (index: number) =>
      options.document ? options.document.positionAt(index) : positionAt({ text, offsets }, index);
    const classRegex = /class\s+(\w+)\s*:\s*XCTestCase\s*\{/g;
    const classes: DiscoveredTestClass[] = [];

    while (true) {
      const classMatch = classRegex.exec(text);
      if (classMatch === null) break;
      const className = classMatch[1];
      const classStartIndex = classMatch.index + classMatch[0].length;
      const classPosition = getPosition(classMatch.index);
      const classRange = new vscode.Range(classPosition, classPosition);

      const classCode = extractCodeBlock(text, classStartIndex - 1);
      if (classCode === null) continue;

      const methods: DiscoveredTestMethod[] = [];
      const funcRegex = /func\s+(test\w+)\s*\(/g;
      while (true) {
        const funcMatch = funcRegex.exec(classCode);
        if (funcMatch === null) break;
        const testName = funcMatch[1];
        const testStartIndex = classStartIndex + funcMatch.index;
        const position = getPosition(testStartIndex);
        const range = new vscode.Range(position, position);
        methods.push({
          name: testName,
          range: range,
        });
      }

      if (methods.length === 0) {
        continue;
      }

      classes.push({
        name: className,
        range: classRange,
        methods: methods,
      });
    }

    return classes;
  }

  /**
   * Parse Objective-C XCTestCase classes and test methods from @implementation blocks
   */
  private parseObjCTests(options: { text: string; document?: vscode.TextDocument; uri: vscode.Uri }): DiscoveredTestClass[] {
    const { text, uri } = options;
    const offsets = options.document ? undefined : buildLineOffsets(text);
    const getPosition = (index: number) =>
      options.document ? options.document.positionAt(index) : positionAt({ text, offsets }, index);

    // Check for XCTest imports (direct or indirect via test case base classes)
    const hasXCTestImport = /#\s*import\s*<\s*XCTest\/XCTest\.h\s*>|@import\s+XCTest\s*;/.test(text);
    // Match imports of *TestCase.h files (e.g., "LPSessionTestCase.h" or <CustomTestCase.h>)
    // Uses non-greedy match to find TestCase.h within the import statement
    const hasTestCaseImport = /#\s*import\s+["<].*?TestCase\.h[">]/.test(text);

    // Identify explicit test classes via @interface ... : XCTestCase or ... : *TestCase
    const interfaceRegexXCTest = /@interface\s+(\w+)\s*:\s*XCTestCase\b/g;
    const interfaceRegexTestCase = /@interface\s+(\w+)\s*:\s*\w*TestCase\b/g;
    const explicitTestClasses = new Set<string>();
    while (true) {
      const im = interfaceRegexXCTest.exec(text);
      if (im === null) break;
      explicitTestClasses.add(im[1]);
    }
    while (true) {
      const im = interfaceRegexTestCase.exec(text);
      if (im === null) break;
      explicitTestClasses.add(im[1]);
    }

    // Find all @implementation blocks and capture class name; merge categories under same class
    const implRegex = /@implementation\s+(\w+)(?:\s*\([^)]*\))?[\s\S]*?@end/g;
    const methodRegex = /-\s*\([^)]*\)\s*(test\w+)\s*(?=[{;]|\s*[{;])/g;

    const classes: DiscoveredTestClass[] = [];

    while (true) {
      const implMatch = implRegex.exec(text);
      if (implMatch === null) break;
      const className = implMatch[1];
      const classPos = getPosition(implMatch.index);
      const classRange = new vscode.Range(classPos, classPos);

      const implBody = text.slice(implMatch.index, implRegex.lastIndex);
      methodRegex.lastIndex = 0;

      const methods: DiscoveredTestMethod[] = [];
      while (true) {
        const m = methodRegex.exec(implBody);
        if (m === null) break;
        const methodName = m[1];
        const after = implBody.slice(m.index + m[0].length, m.index + m[0].length + 1);
        if (after === ":") continue;

        const methodGlobalIndex = implMatch.index + m.index;
        const methodPos = getPosition(methodGlobalIndex);
        const methodRange = new vscode.Range(methodPos, methodPos);

        methods.push({
          name: methodName,
          range: methodRange,
        });
      }

      if (methods.length === 0) {
        continue;
      }

      // Filter to likely test classes
      const isExplicit = explicitTestClasses.has(className);
      const filePathLower = uri.fsPath.toLowerCase();
      const looksLikeTestName = /tests$/i.test(className) && !/uitests$/i.test(className);
      const inTestsFolder = filePathLower.includes("tests");
      const hasTestMethods = methods.length > 0;

      const isLikelyTestClass =
        isExplicit ||
        (hasXCTestImport && inTestsFolder && looksLikeTestName) ||
        (hasTestCaseImport && inTestsFolder && looksLikeTestName) ||
        (hasTestMethods && inTestsFolder && looksLikeTestName);

      if (!isLikelyTestClass) {
        continue;
      }

      classes.push({
        name: className,
        range: classRange,
        methods: methods,
      });
    }

    return classes;
  }

  /**
   * Refresh discovery for all files in the workspace
   */
  async refreshAllTests(): Promise<void> {
    // Clear all items
    this.controller.items.replace([]);
    this.schemeItems.clear();
    this.fileTargetsCache.clear();

    const includeGlobs = ["**/*.swift", "**/*.m", "**/*.mm"];
    const exclude = "**/*UITests*/**";

    await this.ensureSchemeIndex();

    const uris: vscode.Uri[] = [];
    for (const glob of includeGlobs) {
      const found = await vscode.workspace.findFiles(glob, exclude);
      uris.push(...found);
    }

    for (const uri of uris) {
      const filePathLower = uri.fsPath.toLowerCase();
      if (!filePathLower.includes("tests") || filePathLower.includes("uitests")) continue;
      const text = await this.readFileText(uri);
      await this.updateTestItemsFromText(uri, text);
    }
  }

  private onWorkspaceFileChanged(uri: vscode.Uri) {
    const file = uri.fsPath.toLowerCase();
    if (!(file.endsWith(".swift") || file.endsWith(".m") || file.endsWith(".mm"))) return;
    if (!file.includes("tests") || file.includes("uitests")) return;
    void (async () => {
      const text = await this.readFileText(uri);
      await this.updateTestItemsFromText(uri, text);
    })();
  }

  private onWorkspaceFileDeleted(uri: vscode.Uri) {
    this.removeTestsForUri(uri);
  }

  private async readFileText(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    const decoder = new TextDecoder("utf-8");
    return decoder.decode(data);
  }

  private removeTestsForUri(uri: vscode.Uri) {
    const uriString = uri.toString();
    const schemeItemsToCleanup: vscode.TestItem[] = [];
    for (const [, schemeItem] of this.controller.items) {
      const classIdsToDelete: string[] = [];
      for (const [classId, classItem] of schemeItem.children) {
        if (classItem.uri?.toString() === uriString) {
          classIdsToDelete.push(classId);
        }
      }
      for (const classId of classIdsToDelete) {
        schemeItem.children.delete(classId);
      }
      if (schemeItem.children.size === 0) {
        schemeItemsToCleanup.push(schemeItem);
      }
    }
    for (const schemeItem of schemeItemsToCleanup) {
      this.cleanupSchemeItem(schemeItem);
    }
  }

  private async updateTestItemsFromText(uri: vscode.Uri, text: string): Promise<void> {
    this.removeTestsForUri(uri);

    const isSwift = uri.fsPath.endsWith(".swift");
    const isObjC = uri.fsPath.endsWith(".m") || uri.fsPath.endsWith(".mm");
    if (!isSwift && !isObjC) return;

    let classes: DiscoveredTestClass[] = [];
    if (isSwift) {
      classes = this.parseSwiftTests({ text });
    } else if (isObjC) {
      classes = this.parseObjCTests({ text, uri });
    }

    await this.applyDiscoveredTests(uri, classes);
  }

  private async applyDiscoveredTests(uri: vscode.Uri, classes: DiscoveredTestClass[]): Promise<void> {
    if (classes.length === 0) {
      return;
    }
    await this.ensureSchemeIndex();
    const schemes = await this.resolveSchemesForFile(uri.fsPath);
    const schemeNames = schemes.length > 0 ? schemes : [UNKNOWN_SCHEME_NAME];

    for (const schemeName of schemeNames) {
      const schemeItem = this.getOrCreateSchemeItem(schemeName);
      for (const discoveredClass of classes) {
        const classId = this.buildClassTestId({
          scheme: schemeName,
          uri: uri,
          className: discoveredClass.name,
        });
        schemeItem.children.delete(classId);
        const classItem = this.createTestItem({
          id: classId,
          label: discoveredClass.name,
          uri: uri,
          type: "class",
          scheme: schemeName,
          className: discoveredClass.name,
        });
        classItem.range = discoveredClass.range;
        schemeItem.children.add(classItem);

        for (const method of discoveredClass.methods) {
          const methodId = this.buildMethodTestId({
            classId: classId,
            methodName: method.name,
          });
          classItem.children.delete(methodId);
          const methodItem = this.createTestItem({
            id: methodId,
            label: method.name,
            uri: uri,
            type: "method",
            scheme: schemeName,
            className: discoveredClass.name,
            methodName: method.name,
            parentId: classId,
          });
          methodItem.range = method.range;
          classItem.children.add(methodItem);
        }
      }
    }
  }

  /**
   * Ask common configuration options for running tests
   */
  async askTestingConfigurations(options?: {
    preferredScheme?: string;
  }): Promise<{
    xcworkspace: string;
    scheme: string;
    configuration: string;
    destination: Destination;
  }> {
    // todo: consider to have separate configuration for testing and building. currently we use the
    // configuration for building the project

    const xcworkspace = await askXcodeWorkspacePath(this.context);
    const scheme =
      options?.preferredScheme ??
      (await askSchemeForTesting(this.context, {
        xcworkspace: xcworkspace,
        title: "Select a scheme to run tests",
      }));
    const configuration = await askConfigurationForTesting(this.context, {
      xcworkspace: xcworkspace,
    });
    const buildSettings = await getBuildSettingsToAskDestination({
      scheme: scheme,
      configuration: configuration,
      sdk: undefined,
      xcworkspace: xcworkspace,
    });
    const destination = await askDestinationToTestOn(this.context, buildSettings);
    return {
      xcworkspace: xcworkspace,
      scheme: scheme,
      configuration: configuration,
      destination: destination,
    };
  }

  /**
   * Execute separate command to build the project before running tests
   */
  async buildForTestingCommand(context: ExtensionContext) {
    const { scheme, destination, xcworkspace } = await this.askTestingConfigurations();

    // before testing we need to build the project to avoid runnning tests on old code or
    // building every time we run selected tests
    await this.buildForTesting({
      destination: destination,
      scheme: scheme,
      xcworkspace: xcworkspace,
    });
  }

  /**
   * Build the project for testing
   */
  async buildForTesting(options: {
    scheme: string;
    destination: Destination;
    xcworkspace: string;
    onlyTestingArgs?: string[];
  }) {
    this.context.updateProgressStatus("Building for testing");
    const destinationRaw = getXcodeBuildDestinationString({ destination: options.destination });

    const useXcbeautify = isXcbeautifyEnabled() && (await getIsXcbeautifyInstalled());

    await runTask(this.context, {
      name: "sweetpad.build.build",
      lock: "sweetpad.build",
      terminateLocked: true,
      callback: async (terminal) => {
        const derivedDataPath = prepareDerivedDataPath();
        await terminal.execute({
          command: "xcodebuild",
          args: [
            "build-for-testing",
            "-destination",
            destinationRaw,
            "-allowProvisioningUpdates",
            "-scheme",
            options.scheme,
            "-workspace",
            options.xcworkspace,
            ...(derivedDataPath ? ["-derivedDataPath", derivedDataPath] : []),
            ...(options.onlyTestingArgs ?? []),
          ],
          pipes: useXcbeautify ? [{ command: "xcbeautify", args: [] }] : undefined,
        });
      },
    });
  }

  /**
   * Extract error message from the test output and prepare vscode TestMessage object
   * to display it in the test results.
   */
  getMethodError(options: {
    methodTestId: string;
    runContext: XcodebuildTestRunContext;
  }) {
    const { methodTestId, runContext } = options;

    // Inline error message are usually before the "failed" line
    const error = runContext.getInlineError(methodTestId);
    if (error) {
      // detailed error message with location
      const testMessage = new vscode.TestMessage(error.message);
      testMessage.location = new vscode.Location(
        vscode.Uri.file(error.fileName),
        new vscode.Position(error.lineNumber - 1, 0),
      );
      return testMessage;
    }

    // just geeric error message, no error location or details
    // todo: parse .xcresult file to get more detailed error message
    return new vscode.TestMessage("Test failed (error message is not extracted).");
  }

  /**
   * Parse each line of the `xcodebuild` output to update the test run
   * with the test status and any inline error messages.
   */
  async parseOutputLine(options: {
    line: string;
    className: string;
    testRun: vscode.TestRun;
    runContext: XcodebuildTestRunContext;
  }) {
    const { testRun, className, runContext } = options;
    const line = options.line.trim();

    const methodStatusMatchIOS = line.match(this.METHOD_STATUS_REGEXP_IOS);
    if (methodStatusMatchIOS) {
      const [, , methodName, status] = methodStatusMatchIOS;
      const methodTestId = `${className}.${methodName}`;

      const methodTest = runContext.getMethodTest(methodTestId);
      if (!methodTest) {
        return;
      }

      if (status.startsWith("started")) {
        testRun.started(methodTest);
      } else if (status.startsWith("passed")) {
        testRun.passed(methodTest);
        runContext.addProcessedMethodTest(methodTestId);
      } else if (status.startsWith("failed")) {
        const error = this.getMethodError({
          methodTestId: methodTestId,
          runContext: runContext,
        });
        testRun.failed(methodTest, error);
        runContext.addProcessedMethodTest(methodTestId);
        runContext.addFailedMethodTest(methodTestId);
      }
      return;
    }

    const methodStatusMatchMacOS = line.match(this.METHOD_STATUS_REGEXP_MACOS);
    if (methodStatusMatchMacOS) {
      const [, outputClassName, methodName, status] = methodStatusMatchMacOS;
      
      // Extract class name from output (may include module prefix like "Module.ClassName")
      // Try to match using the class name from output, handling module prefixes
      let actualClassName = outputClassName;
      if (outputClassName.includes(".")) {
        // If class name includes module prefix, extract just the class name part
        actualClassName = outputClassName.split(".").pop() ?? outputClassName;
      }
      
      // Try to find the test using the extracted class name first, then fall back to the parameter
      let methodTestId = `${actualClassName}.${methodName}`;
      let methodTest = runContext.getMethodTest(methodTestId);
      
      if (!methodTest) {
        // Fall back to using the className parameter
        methodTestId = `${className}.${methodName}`;
        methodTest = runContext.getMethodTest(methodTestId);
      }
      
      // If still not found, try to find by matching the test item's method name
      if (!methodTest) {
        for (const [key, test] of runContext.getMethodTests()) {
          const testInfo = this.getClassMethodInfo(test);
          if (testInfo?.methodName === methodName) {
            methodTest = test;
            methodTestId = key;
            break;
          }
        }
      }
      
      if (!methodTest) {
        return;
      }

      if (status.startsWith("started")) {
        testRun.started(methodTest);
      } else if (status.startsWith("passed")) {
        testRun.passed(methodTest);
        runContext.addProcessedMethodTest(methodTestId);
      } else if (status.startsWith("failed")) {
        const error = this.getMethodError({
          methodTestId: methodTestId,
          runContext: runContext,
        });
        testRun.failed(methodTest, error);
        runContext.addProcessedMethodTest(methodTestId);
        runContext.addFailedMethodTest(methodTestId);
      }
      return;
    }

    const inlineErrorMatch = line.match(this.INLINE_ERROR_REGEXP);
    if (inlineErrorMatch) {
      const [, filePath, lineNumber, methodName, errorMessage] = inlineErrorMatch;
      const testId = `${className}.${methodName}`;
      runContext.addInlineError(testId, {
        fileName: filePath,
        lineNumber: Number.parseInt(lineNumber, 10),
        message: errorMessage,
      });
      return;
    }
  }

  /**
   * Get list of method tests that should be runned
   */
  prepareQueueForRun(request: vscode.TestRunRequest): vscode.TestItem[] {
    const initial: vscode.TestItem[] = [];

    if (request.include) {
      initial.push(...request.include);
    } else {
      for (const [, root] of this.controller.items) {
        initial.push(root);
      }
    }

    const queue: vscode.TestItem[] = [];
    const seenClassIds = new Set<string>();

    const enqueue = (item: vscode.TestItem) => {
      const ctx = this.getItemContext(item);
      if (!ctx) {
        return;
      }
      if (ctx.type === "scheme") {
        for (const [, child] of item.children) {
          enqueue(child);
        }
        return;
      }
      if (ctx.type === "class") {
        if (seenClassIds.has(item.id)) {
          return;
        }
        seenClassIds.add(item.id);
        queue.push(item);
        return;
      }
      if (ctx.type === "method") {
        if (ctx.parentId && seenClassIds.has(ctx.parentId)) {
          return;
        }
        queue.push(item);
      }
    };

    for (const item of initial) {
      enqueue(item);
    }

    return queue;
  }

  private summarizeQueueSchemes(queue: vscode.TestItem[]): {
    explicitSchemes: Set<string>;
    hasUnknown: boolean;
  } {
    const summary = {
      explicitSchemes: new Set<string>(),
      hasUnknown: false,
    };
    for (const item of queue) {
      const ctx = this.getItemContext(item);
      const scheme = ctx?.scheme;
      if (!scheme || scheme === UNKNOWN_SCHEME_NAME) {
        summary.hasUnknown = true;
        continue;
      }
      summary.explicitSchemes.add(scheme);
    }
    return summary;
  }

  /**
   * For SPM packages we need to resolve the target name for the test file
   * from the Package.swift file. For some reason it doesn't use the target name
   * from xcode project
   */
  async resolveSPMTestingTarget(options: {
    queue: vscode.TestItem[];
    xcworkspace: string;
  }) {
    const { queue, xcworkspace } = options;
    const workscePath = getWorkspacePath();

    // Cache for resolved target names. Example:
    // - /folder1/folder2/Tests/MyAppTests -> ""
    // - /folder1/folder2/Tests -> ""
    // - /folder1/folder2 -> "MyAppTests"
    const pathCache = new Map<string, string>();

    for (const test of queue) {
      const testPath = test.uri?.fsPath;
      if (!testPath) {
        continue;
      }

      // In general all should have context, but check just in case
      const testContext = this.testItems.get(test);
      if (!testContext) {
        continue;
      }

      // Iterate over all ancestors of the test file path to find SPM file
      // Example:
      // /folder1/folder2/folder3/Tests/MyAppTests/MyAppTests.swift
      // /folder1/folder2/folder3/Tests/MyAppTests/
      // /folder1/folder2/folder3/Tests
      // /folder1/folder2/folder3
      for (const ancestorPath of getAncestorsPaths({
        parentPath: workscePath,
        childPath: testPath,
      })) {
        const cachedTarget = pathCache.get(ancestorPath);
        if (cachedTarget !== undefined) {
          // path doesn't have "Package.swift" file, so move to the next ancestor
          if (cachedTarget === "") {
            continue;
          }
          testContext.spmTarget = cachedTarget;
        }

        const packagePath = path.join(ancestorPath, "Package.swift");
        const isPackageExists = await isFileExists(packagePath);
        if (!isPackageExists) {
          pathCache.set(ancestorPath, "");
          continue;
        }

        // stop search and try to get the target name from "Package.swift" file
        try {
          const stdout = await exec({
            command: "swift",
            args: ["package", "dump-package"],
            cwd: ancestorPath,
          });
          const stdoutJson = JSON.parse(stdout);

          const targets = stdoutJson.targets;
          const testTargetNames = targets
            ?.filter((target: any) => target.type === "test")
            .filter((target: any) => {
              const targetPath = target.path
                ? path.join(ancestorPath, target.path)
                : path.join(ancestorPath, "Tests", target.name);
              return testPath.startsWith(targetPath);
            })
            .map((target: any) => target.name);

          if (testTargetNames.length === 1) {
            const testTargetName = testTargetNames[0];
            pathCache.set(ancestorPath, testTargetName);
            testContext.spmTarget = testTargetName;
            return testTargetName;
          }
        } catch (error) {
          // In case of error, we assume that the target name is is name name of test folder:
          // - Tests/{targetName}/{testFile}.swift
          commonLogger.error("Failed to get test target name", {
            error: error,
          });

          const relativePath = path.relative(ancestorPath, testPath);
          const match = relativePath.match(/^Tests\/([^/]+)/);
          if (match) {
            const testTargetName = match[1];
            pathCache.set(ancestorPath, testTargetName);
            testContext.spmTarget = testTargetName;
            return match[1];
          }
        }

        // Package.json exists but we failed to get the target name, let's move on to the next ancestor
        pathCache.set(ancestorPath, "");
        break;
      }
    }
  }

  /**
   * Run selected tests after prepraration and configuration
   */
  async runTests(options: {
    request: vscode.TestRunRequest;
    run: vscode.TestRun;
    xcworkspace: string;
    destination: Destination;
    scheme: string;
    token: vscode.CancellationToken;
    queue?: vscode.TestItem[];
  }) {
    const { xcworkspace, scheme, token, run, request } = options;

    const queue = options.queue ?? this.prepareQueueForRun(request);
    if (queue.length === 0) {
      return;
    }

    if (!options.queue) {
      await this.resolveSPMTestingTarget({
        queue: queue,
        xcworkspace: xcworkspace,
      });
    }

    commonLogger.debug("Running tests", {
      scheme: scheme,
      xcworkspace: xcworkspace,
      tests: queue.map((test) => test.id),
    });

    const defaultTarget = await askTestingTarget(this.context, {
      xcworkspace: xcworkspace,
      title: "Select a target to run tests",
    });

    for (const test of queue) {
      commonLogger.debug("Running single test from queue", {
        testId: test.id,
        testLabel: test.label,
      });

      if (token.isCancellationRequested) {
        run.skipped(test);
        continue;
      }

      const testCtx = this.getItemContext(test);
      if (testCtx?.type === "method") {
        await this.runMethodTest({
          run: run,
          methodTest: test,
          xcworkspace: xcworkspace,
          destination: options.destination,
          scheme: scheme,
          defaultTarget: defaultTarget,
        });
      } else if (testCtx?.type === "class") {
        await this.runClassTest({
          run: run,
          classTest: test,
          scheme: scheme,
          xcworkspace: xcworkspace,
          destination: options.destination,
          defaultTarget: defaultTarget,
        });
      } else {
        commonLogger.warn("Skipped test item with unsupported type", {
          testId: test.id,
        });
      }
    }
  }

  /**
   * Run selected tests without building the project
   * This is faster but you may need to build manually before running tests
   */
  async runTestsWithoutBuilding(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    const run = this.controller.createTestRun(request);
    try {
      const queue = this.prepareQueueForRun(request);
      if (queue.length === 0) {
        void vscode.window.showInformationMessage("No tests selected.");
        return;
      }
      const summary = this.summarizeQueueSchemes(queue);
      if (summary.explicitSchemes.size > 1) {
        void vscode.window.showErrorMessage("Please select tests from a single scheme before running.");
        return;
      }
      const preferredScheme =
        summary.explicitSchemes.size === 1 && !summary.hasUnknown
          ? [...summary.explicitSchemes][0]
          : undefined;

      const { scheme, destination, xcworkspace } = await this.askTestingConfigurations({
        preferredScheme: preferredScheme,
      });

      // todo: add check if project is already built

      this.context.updateProgressStatus("Running tests");
      await this.resolveSPMTestingTarget({
        queue: queue,
        xcworkspace: xcworkspace,
      });
      await this.runTests({
        run: run,
        request: request,
        xcworkspace: xcworkspace,
        destination: destination,
        scheme: scheme,
        token: token,
        queue: queue,
      });
    } finally {
      run.end();
    }
  }

  async debugTestsWithBuild(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    await this.debugTestsMacOS(request, token);
  }

  async debugTestsWithoutBuild(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    await this.debugTestsMacOSWithoutBuilding(request, token);
  }

  /**
   * Debug: run tests and attach CodeLLDB to xctest (macOS)
   */
  private async debugTestsMacOS(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    const run = this.controller.createTestRun(request);
    try {
      const queue = this.prepareQueueForRun(request);
      if (queue.length === 0) {
        void vscode.window.showInformationMessage("No tests selected.");
        return;
      }
      const summary = this.summarizeQueueSchemes(queue);
      if (summary.explicitSchemes.size > 1) {
        void vscode.window.showErrorMessage("Please select tests from a single scheme before debugging.");
        return;
      }
      const preferredScheme =
        summary.explicitSchemes.size === 1 && !summary.hasUnknown
          ? [...summary.explicitSchemes][0]
          : undefined;

      const { scheme, destination, xcworkspace, configuration } = await this.askTestingConfigurations({
        preferredScheme: preferredScheme,
      });

      // Build the selected tests first to ensure up-to-date artifacts and symbols
      await this.resolveSPMTestingTarget({
        queue: queue,
        xcworkspace: xcworkspace,
      });
      await this.resolveXcodeTargetsForQueue({ queue, xcworkspace, scheme });
      const onlyTestingArgs = this.makeOnlyTestingArgs({ queue });
      await this.buildForTesting({
        scheme: scheme,
        destination: destination,
        xcworkspace: xcworkspace,
        onlyTestingArgs: onlyTestingArgs.length > 0 ? onlyTestingArgs : undefined
      });

      await this.launchDebugSession({
        request,
        run,
        scheme,
        xcworkspace,
        configuration,
        sessionNamePrefix: "Debug Tests",
        token,
        queue,
      });
    } finally {
      run.end();
    }
  }

  /**
   * Debug: run tests without building and attach CodeLLDB to xctest (macOS)
   */
  private async debugTestsMacOSWithoutBuilding(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    const run = this.controller.createTestRun(request);
    try {
      const queue = this.prepareQueueForRun(request);
      if (queue.length === 0) {
        void vscode.window.showInformationMessage("No tests selected.");
        return;
      }
      const summary = this.summarizeQueueSchemes(queue);
      if (summary.explicitSchemes.size > 1) {
        void vscode.window.showErrorMessage("Please select tests from a single scheme before debugging.");
        return;
      }
      const preferredScheme =
        summary.explicitSchemes.size === 1 && !summary.hasUnknown
          ? [...summary.explicitSchemes][0]
          : undefined;

      const { scheme, destination, xcworkspace, configuration } = await this.askTestingConfigurations({
        preferredScheme: preferredScheme,
      });

      // Skip building - assume tests are already built
      await this.resolveSPMTestingTarget({
        queue: queue,
        xcworkspace: xcworkspace,
      });
      await this.resolveXcodeTargetsForQueue({ queue, xcworkspace, scheme });

      await this.launchDebugSession({
        request,
        run,
        scheme,
        xcworkspace,
        configuration,
        sessionNamePrefix: "Debug Tests Without Building",
        token,
        queue,
      });
    } finally {
      run.end();
    }
  }

  /**
   * Common debug session launcher for macOS tests
   */
  private async launchDebugSession(options: {
    request: vscode.TestRunRequest;
    run: vscode.TestRun;
    scheme: string;
    xcworkspace: string;
    configuration: string;
    sessionNamePrefix: string;
    token: vscode.CancellationToken;
    queue?: vscode.TestItem[];
  }) {
    const { request, run, scheme, xcworkspace, configuration, sessionNamePrefix, token } = options;
    const queue = options.queue ?? this.prepareQueueForRun(request);
    if (queue.length === 0) {
      void vscode.window.showInformationMessage("No tests selected.");
      return;
    }

    try {
      const xctestPath = (await exec({ command: "xcrun", args: ["--find", "xctest"] })).trim();

      // Resolve products directory to construct the test bundle path and set runtime search paths
      const buildSettings = await (await import("../common/cli/scripts.js")).getBuildSettingsToAskDestination({
        scheme: scheme,
        configuration: configuration,
        sdk: undefined,
        xcworkspace: xcworkspace,
      });
      let productsDir = buildSettings?.buildProductsDir;
      if (!productsDir) {
        const dd = prepareDerivedDataPath();
        if (dd && configuration) {
          productsDir = path.join(dd, "Build", "Products", configuration);
        }
      }

      // Group selected items by target; if empty (run all), fall back to all testable targets
      const targetToItems = new Map<string, vscode.TestItem[]>();
      const onlyTestingMap = this.makeOnlyTestingMap({ queue });
      for (const item of queue) {
        const target = onlyTestingMap.get(item.id);
        if (!target) continue;
        const arr = targetToItems.get(target) ?? [];
        arr.push(item);
        targetToItems.set(target, arr);
      }

      if (targetToItems.size === 0) {
        const schemeTargets = (await this.tryGetSchemeTestTargets({ xcworkspace, scheme })) ?? [];
        for (const t of schemeTargets) {
          targetToItems.set(t, []);
        }
      }

      if (!productsDir || targetToItems.size === 0) {
        void vscode.window.showErrorMessage(
          "SweetPad: Unable to resolve test bundles or products directory for debugging. Check scheme test targets and DerivedData settings.",
        );
        return;
      }

      // Collect all test bundles and their filters
      const testBundles: Array<{ path: string; filters: string[] }> = [];
      for (const [testTarget, items] of targetToItems.entries()) {
        const testBundlePath = path.join(productsDir, `${testTarget}.xctest`);
        
        // Verify bundle exists to avoid silent failure
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(testBundlePath));
        } catch {
          void vscode.window.showErrorMessage(`SweetPad: Test bundle not found: ${testBundlePath}`);
          continue;
        }

        const xctestFilters = this.makeXCTestArgsForTarget({ items, target: testTarget });
        testBundles.push({
          path: testBundlePath,
          filters: xctestFilters
        });
      }

      if (testBundles.length === 0) {
        void vscode.window.showErrorMessage("SweetPad: No valid test bundles found for debugging");
        return;
      }

      // Build single command line with all test bundles
      // xctest expects: xctest [-XCTest filters...] <bundle path>
      const args: string[] = [];
      for (const bundle of testBundles) {
        args.push(...bundle.filters);
        args.push(bundle.path);
      }

      const sessionName = `SweetPad: ${sessionNamePrefix} (${testBundles.length} bundle${testBundles.length > 1 ? 's' : ''})`;

      // Wait for session to start and terminate
      const waitForStart = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          disp.dispose();
          reject(new Error("Debugger did not start in time"));
        }, 10000);
        const disp = vscode.debug.onDidStartDebugSession((s) => {
          if (s.name === sessionName) {
            clearTimeout(timeout);
            disp.dispose();
            resolve();
          }
        });
      });
      const waitForEnd = new Promise<void>((resolve) => {
        const disp = vscode.debug.onDidTerminateDebugSession((s) => {
          if (s.name === sessionName) {
            disp.dispose();
            resolve();
          }
        });
      });

      const ok = await vscode.debug.startDebugging(undefined, {
        type: "lldb",
        request: "launch",
        name: sessionName,
        program: xctestPath,
        args: args,
        env: productsDir
          ? {
              DYLD_FRAMEWORK_PATH: productsDir,
              DYLD_LIBRARY_PATH: productsDir,
              NSUnbufferedIO: "YES",
            }
          : undefined,
      } as any);

      if (!ok) {
        void vscode.window.showErrorMessage("SweetPad: Failed to start debugger");
        return;
      }

      try {
        await waitForStart;
      } catch (e) {
        void vscode.window.showErrorMessage(`SweetPad: Debugger did not start: ${String(e)}`);
        return;
      }
      await waitForEnd;
    } catch (e) {
      void vscode.window.showErrorMessage(`SweetPad: Failed to prepare debug session: ${String(e)}`);
      return;
    }

    this.context.updateProgressStatus("Running tests under debugger");
  }

  private async waitForLocalProcess(options: {
    name: string;
    timeoutMs: number;
    token?: vscode.CancellationToken;
  }): Promise<number | null> {
    const start = Date.now();
    while (Date.now() - start < options.timeoutMs) {
      if (options.token?.isCancellationRequested) return null;
      try {
        const stdout = await exec({ command: "pgrep", args: ["-x", options.name] });
        const pids = stdout
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => Number.parseInt(s, 10))
          .filter((n) => Number.isFinite(n));
        if (pids.length > 0) {
          // pick the largest pid (most recent)
          return pids.sort((a, b) => b - a)[0];
        }
      } catch {
        // pgrep may return non-zero if not found; ignore
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  /**
   * Build the project and run the selected tests
   */
  async buildAndRunTests(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
    const run = this.controller.createTestRun(request);
    try {
      const queue = this.prepareQueueForRun(request);
      if (queue.length === 0) {
        void vscode.window.showInformationMessage("No tests selected.");
        return;
      }
      const summary = this.summarizeQueueSchemes(queue);
      if (summary.explicitSchemes.size > 1) {
        void vscode.window.showErrorMessage("Please select tests from a single scheme before running.");
        return;
      }
      const preferredScheme =
        summary.explicitSchemes.size === 1 && !summary.hasUnknown
          ? [...summary.explicitSchemes][0]
          : undefined;

      const { scheme, destination, xcworkspace } = await this.askTestingConfigurations({
        preferredScheme: preferredScheme,
      });

      // Determine tests to build and run
      // Annotate SPM targets before generating only-testing list
      await this.resolveSPMTestingTarget({
        queue: queue,
        xcworkspace: xcworkspace,
      });

      const onlyTestingArgs = this.makeOnlyTestingArgs({ queue });

      // Build only selected tests (when identifiable); otherwise do a generic build-for-testing
      await this.buildForTesting({
        scheme: scheme,
        destination: destination,
        xcworkspace: xcworkspace,
        onlyTestingArgs: onlyTestingArgs.length > 0 ? onlyTestingArgs : undefined,
      });

      await this.runTests({
        run: run,
        request: request,
        xcworkspace: xcworkspace,
        destination: destination,
        scheme: scheme,
        token: token,
        queue: queue,
      });
    } finally {
      run.end();
    }
  }

  /**
   * Build -only-testing arguments for a queue of tests where target is known
   */
  private makeOnlyTestingArgs(options: { queue: vscode.TestItem[] }): string[] {
    const args: string[] = [];
    for (const item of options.queue) {
      const ctx = this.testItems.get(item);
      const target = ctx?.xcodeTarget ?? ctx?.spmTarget;
      if (!target) continue;
      const info = this.getClassMethodInfo(item);
      if (!info) {
        continue;
      }
      const spec = info.methodName ? `${target}/${info.className}/${info.methodName}` : `${target}/${info.className}`;
      args.push(`-only-testing:${spec}`);
    }
    return args;
  }

  /**
   * Resolve Xcode targets for each test item using scheme+file heuristics
   */
  private async resolveXcodeTargetsForQueue(options: {
    queue: vscode.TestItem[];
    xcworkspace: string;
    scheme: string;
  }): Promise<void> {
    for (const item of options.queue) {
      const ctx = this.testItems.get(item);
      if (!ctx) continue;
      // Skip if already resolved (e.g., SPM target)
      if (ctx.xcodeTarget) continue;

      const byFile =
        (await this.tryGetTargetsByFilePath({
          xcworkspace: options.xcworkspace,
          testFilePath: item.uri?.fsPath,
        })) ?? [];
      const byScheme =
        (await this.tryGetSchemeTestTargets({
          xcworkspace: options.xcworkspace,
          scheme: options.scheme,
        })) ?? [];
      const intersection = byScheme.filter((t) => byFile.includes(t));
      const ordered = [...intersection, ...byScheme, ...byFile, ctx.spmTarget ?? undefined].filter(
        (t): t is string => !!t,
      );
      if (ordered.length > 0) {
        ctx.xcodeTarget = ordered[0];
      }
    }
  }

  /**
   * Build a map from test item id to resolved target name (when available)
   */
  private makeOnlyTestingMap(options: { queue: vscode.TestItem[] }): Map<string, string> {
    const map = new Map<string, string>();
    for (const item of options.queue) {
      const id = item.id;
      const ctx = this.testItems.get(item);
      const target = ctx?.xcodeTarget ?? ctx?.spmTarget;
      if (target) {
        map.set(id, target);
      }
    }
    return map;
  }

  /**
   * Create -XCTest filter args for a specific target, based on selected items
   */
  private makeXCTestArgsForTarget(options: {
    items: vscode.TestItem[];
    target: string;
  }): string[] {
    const args: string[] = [];
    for (const item of options.items) {
      const ctx = this.testItems.get(item);
      const itemTarget = ctx?.xcodeTarget ?? ctx?.spmTarget;
      if (itemTarget !== options.target) continue;

      const pushFilter = (filter: string) => {
        args.push("-XCTest", filter);
      };

      const info = this.getClassMethodInfo(item);
      if (!info) {
        continue;
      }

      if (!info.methodName) {
        // Class-level selection: enumerate child methods
        for (const [, child] of item.children) {
          const childInfo = this.getClassMethodInfo(child);
          if (!childInfo?.methodName) continue;
          // xctest always uses ClassName/methodName format, regardless of Swift/ObjC
          pushFilter(`${childInfo.className}/${childInfo.methodName}`);
        }
      } else {
        // Method-level selection
        // xctest always uses ClassName/methodName format, regardless of Swift/ObjC
        pushFilter(`${info.className}/${info.methodName}`);
      }
    }
    return args;
  }

  async runClassTest(options: {
    run: vscode.TestRun;
    classTest: vscode.TestItem;
    scheme: string;
    xcworkspace: string;
    destination: Destination;
    defaultTarget: string | null;
  }): Promise<void> {
    const { run, classTest, scheme, defaultTarget } = options;
    const classInfo = this.getClassMethodInfo(classTest);
    if (!classInfo) {
      run.skipped(classTest);
      return;
    }
    const className = classInfo.className;

    run.started(classTest);

    const destinationRaw = getXcodeBuildDestinationString({ destination: options.destination });
    const itemCtx = this.testItems.get(classTest);
    const spm = itemCtx?.spmTarget ?? null;
    const byFile = (await this.tryGetTargetsByFilePath({
      xcworkspace: options.xcworkspace,
      testFilePath: classTest.uri?.fsPath,
    })) ?? [];
    const byScheme = (await this.tryGetSchemeTestTargets({
      xcworkspace: options.xcworkspace,
      scheme,
    })) ?? [];

    // Intersect first (most preferred), then scheme, then file, then spm/default
    const intersection = byScheme.filter((t) => byFile.includes(t));
    const ordered = [...intersection, ...byScheme, ...byFile, spm ?? undefined, defaultTarget ?? undefined].filter(
      (t): t is string => !!t,
    );
    const targets = Array.from(new Set(ordered));

    const methodEntries: Array<[string, vscode.TestItem]> = [];
    for (const [, child] of classTest.children) {
      const methodKey = this.getMethodTestKey(child);
      if (!methodKey) {
        continue;
      }
      methodEntries.push([methodKey, child]);
    }
    if (methodEntries.length === 0) {
      run.skipped(classTest);
      return;
    }

    const runContext = new XcodebuildTestRunContext({ methodTests: methodEntries });
    let succeeded = false;
    let lastError: unknown = null;

    for (const testTarget of targets) {
      try {
        await runTask(this.context, {
          name: "sweetpad.build.test",
          lock: "sweetpad.build",
          terminateLocked: true,
          callback: async (terminal) => {
            const derivedDataPath = prepareDerivedDataPath();
            await terminal.execute({
              command: "xcodebuild",
              args: [
                "test-without-building",
                "-workspace",
                options.xcworkspace,
                "-destination",
                destinationRaw,
                "-scheme",
                scheme,
                ...(derivedDataPath ? ["-derivedDataPath", derivedDataPath] : []),
                `-only-testing:${testTarget}/${className}`,
              ],
              onOutputLine: async (output) => {
                await this.parseOutputLine({
                  line: output.value,
                  testRun: run,
                  className: className,
                  runContext: runContext,
                });
              },
            });
          },
        });
        succeeded = true;
        break;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("isn’t a member of the specified test plan or scheme") || msg.includes("isn't a member")) {
          continue; // try next candidate
        }
        break; // hard error
      }
    }

    // Finalize results
    for (const methodTest of runContext.getUnprocessedMethodTests()) {
      run.skipped(methodTest);
    }
    const overallStatus = runContext.getOverallStatus();
    if (overallStatus === "failed") {
      run.failed(classTest, new vscode.TestMessage("One or more tests failed."));
    } else if (overallStatus === "passed") {
      run.passed(classTest);
    } else if (!succeeded) {
      const errorMessage = lastError instanceof Error ? lastError.message : "Could not run tests for this class.";
      run.failed(classTest, new vscode.TestMessage(errorMessage));
    } else {
      run.skipped(classTest);
    }
  }

  async runMethodTest(options: {
    run: vscode.TestRun;
    methodTest: vscode.TestItem;
    xcworkspace: string;
    scheme: string;
    destination: Destination;
    defaultTarget: string | null;
  }): Promise<void> {
    const { run: testRun, methodTest, scheme, defaultTarget } = options;
    const methodInfo = this.getClassMethodInfo(methodTest);
    if (!methodInfo?.methodName) {
      testRun.skipped(methodTest);
      return;
    }
    const className = methodInfo.className;
    const methodName = methodInfo.methodName;
    const methodKey = `${className}.${methodName}`;

    const destinationRaw = getXcodeBuildDestinationString({ destination: options.destination });
    const itemCtx = this.testItems.get(methodTest);
    const spm = itemCtx?.spmTarget ?? null;
    const byFile = (await this.tryGetTargetsByFilePath({
      xcworkspace: options.xcworkspace,
      testFilePath: methodTest.uri?.fsPath,
    })) ?? [];
    const byScheme = (await this.tryGetSchemeTestTargets({
      xcworkspace: options.xcworkspace,
      scheme,
    })) ?? [];
    const intersection = byScheme.filter((t) => byFile.includes(t));
    const ordered = [...intersection, ...byScheme, ...byFile, spm ?? undefined, defaultTarget ?? undefined].filter(
      (t): t is string => !!t,
    );
    const targets = Array.from(new Set(ordered));

    const runContext = new XcodebuildTestRunContext({ methodTests: [[methodKey, methodTest]] });
    let succeeded = false;
    let lastError: unknown = null;

    for (const testTarget of targets) {
      try {
        await runTask(this.context, {
          name: "sweetpad.build.test",
          lock: "sweetpad.build",
          terminateLocked: true,
          callback: async (terminal) => {
            const derivedDataPath = prepareDerivedDataPath();
            await terminal.execute({
              command: "xcodebuild",
              args: [
                "test-without-building",
                "-workspace",
                options.xcworkspace,
                "-destination",
                destinationRaw,
                "-scheme",
                scheme,
                ...(derivedDataPath ? ["-derivedDataPath", derivedDataPath] : []),
                `-only-testing:${testTarget}/${className}/${methodName}`,
              ],
              onOutputLine: async (output) => {
                await this.parseOutputLine({
                  line: output.value,
                  testRun: testRun,
                  className: className,
                  runContext: runContext,
                });
              },
            });
          },
        });
        succeeded = true;
        break;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("isn’t a member of the specified test plan or scheme") || msg.includes("isn't a member")) {
          continue; // try next candidate
        }
        break; // hard error
      }
    }

    if (!runContext.isMethodTestProcessed(methodKey)) {
      if (succeeded) {
        testRun.skipped(methodTest);
      } else {
        const errorMessage = lastError instanceof Error ? lastError.message : "Test failed";
        testRun.failed(methodTest, new vscode.TestMessage(errorMessage));
      }
    }
  }

  private async tryGetSchemeTestTargets(options: { xcworkspace: string; scheme: string }): Promise<string[] | null> {
    try {
      const workspace = await (await import("../common/xcode/workspace.js")).XcodeWorkspace.parseWorkspace(
        options.xcworkspace,
      );
      const scheme = await workspace.getScheme({ name: options.scheme });
      if (!scheme) return null;
      const all = await scheme.getTestableTargets();
      const filtered = all.filter((t) => !/UITests/i.test(t));
      return (filtered.length > 0 ? filtered : all) ?? null;
    } catch (_e) {
      return null;
    }
  }

  private async tryGetTargetsByFilePath(options: {
    xcworkspace: string;
    testFilePath?: string;
  }): Promise<string[] | null> {
    try {
      if (!options.testFilePath) return null;
      const workspace = await (await import("../common/xcode/workspace.js")).XcodeWorkspace.parseWorkspace(
        options.xcworkspace,
      );
      const targets = await workspace.getTestTargetsForFile(options.testFilePath);
      const filtered = targets.filter((t) => !/UITests/i.test(t));
      return (filtered.length > 0 ? filtered : targets) ?? null;
    } catch {
      return null;
    }
  }
}
