import vscode from "vscode";
import type {
  ExtensionContext,
  LastLaunchedAppDeviceContext,
  LastLaunchedAppMacOSContext,
  LastLaunchedAppSimulatorContext,
} from "../common/commands";
import { exec } from "../common/exec";
import { commonLogger } from "../common/logger";
import { checkUnreachable } from "../common/types";
import { waitForProcessToLaunch } from "./utils";

const ATTACH_CONFIG: vscode.DebugConfiguration = {
  type: "sweetpad-lldb",
  request: "attach",
  name: "SweetPad: Build and Run (Wait for debugger)",
  preLaunchTask: "sweetpad: debugging-launch",
};

class InitialDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  async provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
    token?: vscode.CancellationToken | undefined,
  ): Promise<vscode.DebugConfiguration[]> {
    return [ATTACH_CONFIG];
  }

  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken | undefined,
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (Object.keys(config).length === 0) {
      return ATTACH_CONFIG;
    }
    return config;
  }
}

class DynamicDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  context: ExtensionContext;
  constructor(options: { context: ExtensionContext }) {
    this.context = options.context;
  }

  async provideDebugConfigurations(
    folder: vscode.WorkspaceFolder | undefined,
    token?: vscode.CancellationToken | undefined,
  ): Promise<vscode.DebugConfiguration[]> {
    return [ATTACH_CONFIG];
  }

  async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken | undefined,
  ): Promise<vscode.DebugConfiguration | undefined> {
    // Kill any previous app process and terminate debug sessions BEFORE preLaunchTask runs
    await this.terminateActiveDebugSessions();

    if (Object.keys(config).length === 0) {
      return ATTACH_CONFIG;
    }
    return config;
  }

  /**
   * Waits for the process to be in a clean state, ready for debugging.
   * This helps prevent "process already being debugged" errors by ensuring
   * any stale debugger attachments are cleared.
   */
  private async waitForCleanProcessState(appPath: string, maxWaitMs: number = 2000): Promise<void> {
    const startTime = Date.now();
    const executableName = appPath.split("/").pop();
    if (!executableName) {
      return;
    }

    while (Date.now() - startTime < maxWaitMs) {
      try {
        // Check if process exists
        const stdout = await exec({ command: "pgrep", args: ["-x", executableName] });
        const pids = stdout
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => Number.parseInt(s, 10))
          .filter((n) => Number.isFinite(n));

        let foundProcess = false;
        for (const pid of pids) {
          try {
            const psOutput = await exec({ command: "ps", args: ["-p", pid.toString(), "-o", "command="] });
            if (psOutput.trim().includes(appPath)) {
              foundProcess = true;
              // Process exists - check if there are any VS Code debug sessions still active
              // If there are no active debug sessions, the process should be clean
              const activeSession = vscode.debug.activeDebugSession;
              if (!activeSession || activeSession.type !== "lldb") {
                // No active LLDB session, process should be ready
                // Wait a bit more to ensure any stale state clears
                await new Promise((resolve) => setTimeout(resolve, 300));
                return;
              }
            }
          } catch (e) {
            commonLogger.debug("Failed to check process", { pid, error: e });
          }
        }

        if (!foundProcess) {
          // Process not found yet, wait a bit
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }

        // Process exists but there might be a debug session, wait a bit
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (e) {
        // Process not found yet, that's okay - wait
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Final wait to ensure any OS-level cleanup is complete
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  private async resolveMacOSDebugConfiguration(
    config: vscode.DebugConfiguration,
    launchContext: LastLaunchedAppMacOSContext,
  ): Promise<vscode.DebugConfiguration> {
    // Wait for the process to be in a clean state before attaching
    // This helps prevent "process already being debugged" errors
    await this.waitForCleanProcessState(launchContext.appPath);

    config.type = "lldb";
    config.waitFor = true;
    config.request = "attach";
    config.program = launchContext.appPath;
    commonLogger.log("Resolved debug configuration", { config: config });
    return config;
  }

  private async resolveSimulatorDebugConfiguration(
    config: vscode.DebugConfiguration,
    launchContext: LastLaunchedAppSimulatorContext,
  ): Promise<vscode.DebugConfiguration> {
    config.type = "lldb";
    config.waitFor = true;
    config.request = "attach";
    config.program = launchContext.appPath;
    commonLogger.log("Resolved debug configuration", { config: config });
    return config;
  }

  private async resolveDeviceDebugConfiguration(
    config: vscode.DebugConfiguration,
    launchContext: LastLaunchedAppDeviceContext,
  ): Promise<vscode.DebugConfiguration> {
    const deviceUDID = launchContext.destinationId;
    const hostAppPath = launchContext.appPath;
    const appName = launchContext.appName; // Example: "MyApp.app"

    // We need to find the device app path and the process id
    const process = await waitForProcessToLaunch(this.context, {
      deviceId: deviceUDID,
      appName: appName,
      timeoutMs: 15000, // wait for 15 seconds before giving up
    });

    const deviceExecutableURL = process.executable;
    if (!deviceExecutableURL) {
      throw new Error("No device app path found");
    }

    // Remove the "file://" prefix and remove everything after the app name
    // Result should be something like:
    //  - "/private/var/containers/Bundle/Application/5045C7CE-DFB9-4C17-BBA9-94D8BCD8F565/Mastodon.app"
    const deviceAppPath = deviceExecutableURL.match(/^file:\/\/(.*\.app)/)?.[1];
    const processId = process.processIdentifier;

    const continueOnAttach = config.continueOnAttach ?? true;

    // LLDB commands executed upon debugger startup.
    config.initCommands = [
      ...(config.initCommands || []),
      // By default, LLDB runs against the local host platform. This command switches LLDB to a remote
      // iOS environment, necessary for debugging iOS apps on a device.
      "platform select remote-ios",
      // Don't stop after attaching to the process:
      // -n false — Should LLDB print a “stopped with SIGSTOP” message in the UI? Be silent—no notification to you
      // -p true — Should LLDB forward the signal on to your app? Deliver SIGSTOP to the process
      // -s false — Should LLDB pause (break into the debugger) when this signal arrives?  Don’t break; just run LLDB’s signal handler logic
      ...(continueOnAttach ? ["process handle SIGSTOP -p true -s false -n false"] : []),
    ];

    // LLDB commands executed just before launching of attaching to the debuggee.
    config.preRunCommands = [
      ...(config.preRunCommands || []),
      // Adjusts the loaded module’s file specification to point to the actual location of the binary on the remote device.
      // This ensures symbol resolution and breakpoints align correctly with the actual remote binary.
      `script lldb.target.module[0].SetPlatformFileSpec(lldb.SBFileSpec('${deviceAppPath}'))`,
    ];

    // LLDB commands executed to create/attach the debuggee process.
    config.processCreateCommands = [
      ...(config.processCreateCommands || []),
      // Tells LLDB which physical iOS device (by UDID) you want to attach to.
      `script lldb.debugger.HandleCommand("device select ${deviceUDID}")`,
      // Attaches LLDB to the already-launched process on that device.
      `script lldb.debugger.HandleCommand("device process attach --continue --pid ${processId}")`,
    ];

    // LLDB commands executed after the debuggee process has been created/attached.
    config.postRunCommands = [...(config.postRunCommands || []), `script print("SweetPad: Happy debugging!")`];

    config.type = "lldb";
    config.request = "attach";
    config.program = hostAppPath;
    config.pid = processId.toString();

    commonLogger.log("Resolved debug configuration", { config: config });
    return config;
  }

  /**
   * Terminates the macOS app process if it's running.
   * Force kills with -KILL to ensure termination even if attached to a debugger.
   * Retries if the process is still running after the first kill attempt.
   */
  private async terminateMacOSAppProcess(appPath: string): Promise<void> {
    try {
      // Extract the executable name from the path (e.g., "/path/to/App.app/Contents/MacOS/App" -> "App")
      const executableName = appPath.split("/").pop();
      if (!executableName) {
        return;
      }

      // Find and kill processes, with retry logic
      let attempts = 0;
      const maxAttempts = 3;
      
      while (attempts < maxAttempts) {
        attempts++;
        
        try {
          const stdout = await exec({ command: "pgrep", args: ["-x", executableName] });
          const pids = stdout
            .split(/\s+/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => Number.parseInt(s, 10))
            .filter((n) => Number.isFinite(n));

          if (pids.length === 0) {
            // No processes found, we're done
            break;
          }

          let killedAny = false;
          for (const pid of pids) {
            try {
              // Verify this is actually our process by checking the full path
              const psOutput = await exec({ command: "ps", args: ["-p", pid.toString(), "-o", "command="] });
              if (psOutput.trim().includes(appPath)) {
                // Force kill the process with -KILL to ensure termination even if attached to debugger
                try {
                  await exec({ command: "kill", args: ["-KILL", pid.toString()] });
                  commonLogger.log("Terminated macOS app process", { pid, appPath, attempt: attempts });
                  killedAny = true;
                } catch (killError) {
                  // Process might have been killed by another process, check if it still exists
                  try {
                    await exec({ command: "ps", args: ["-p", pid.toString()] });
                    // Process still exists, will retry
                  } catch (psError) {
                    // Process is gone, that's fine
                    commonLogger.debug("Process already terminated", { pid });
                  }
                }
              }
            } catch (e) {
              // Process might have already terminated, ignore
              commonLogger.debug("Failed to kill process or already terminated", { pid, error: e });
            }
          }

          if (!killedAny) {
            // No processes to kill, we're done
            break;
          }

          // Wait for cleanup between attempts
          await new Promise((resolve) => setTimeout(resolve, 300));
        } catch (e) {
          // pgrep returns non-zero if no processes found, which is fine
          commonLogger.debug("No running process found for macOS app", { appPath, error: e });
          break;
        }
      }

      // Final cleanup delay
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (e) {
      commonLogger.warn("Failed to terminate macOS app process", { appPath, error: e });
    }
  }

  /**
   * Terminates any active debug sessions to avoid "process already being debugged" errors.
   * Also terminates the app process for macOS.
   */
  private async terminateActiveDebugSessions(): Promise<void> {
    const activeSessions: vscode.DebugSession[] = [];
    let currentSession = vscode.debug.activeDebugSession;
    while (currentSession) {
      if (activeSessions.find((s) => s.id === currentSession!.id)) {
        break;
      }
      activeSessions.push(currentSession);
      void vscode.debug.stopDebugging(currentSession);
      await new Promise((resolve) => setTimeout(resolve, 100));
      currentSession = vscode.debug.activeDebugSession;
    }

    // For macOS, also kill the app process
    const launchContext = this.context.getWorkspaceState("build.lastLaunchedApp");
    if (launchContext?.type === "macos") {
      await this.terminateMacOSAppProcess(launchContext.appPath);
    }

    if (activeSessions.length === 0 && !launchContext) {
      return;
    }

    try {
      const terminationPromises = activeSessions.map((session) => {
        return new Promise<void>((resolve) => {
          const disposable = vscode.debug.onDidTerminateDebugSession((terminatedSession) => {
            if (terminatedSession.id === session.id) {
              clearTimeout(timeout);
              disposable.dispose();
              resolve();
            }
          });

          const timeout = setTimeout(() => {
            disposable.dispose();
            resolve();
          }, 3000);
        });
      });

      await Promise.all(terminationPromises);
      // Wait longer to ensure OS-level debug state is cleared
      // The P_TRACED flag can persist briefly after debugger termination
      await new Promise((resolve) => setTimeout(resolve, 800));
    } catch (e) {
      commonLogger.warn("Failed to terminate debug sessions", { error: e });
    }
  }

  /*
   * We use this method because it runs after "preLaunchTask" is completed, "resolveDebugConfiguration"
   * runs before "preLaunchTask" so it's not suitable for our use case without some hacks.
   */
  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    token?: vscode.CancellationToken | undefined,
  ): Promise<vscode.DebugConfiguration> {
    // Only terminate debug sessions here - don't kill the app since we just launched it in preLaunchTask
    const activeSessions: vscode.DebugSession[] = [];
    let currentSession = vscode.debug.activeDebugSession;
    while (currentSession) {
      if (activeSessions.find((s) => s.id === currentSession!.id)) {
        break;
      }
      activeSessions.push(currentSession);
      void vscode.debug.stopDebugging(currentSession);
      await new Promise((resolve) => setTimeout(resolve, 100));
      currentSession = vscode.debug.activeDebugSession;
    }

    if (activeSessions.length > 0) {
      try {
        const terminationPromises = activeSessions.map((session) => {
          return new Promise<void>((resolve) => {
            const disposable = vscode.debug.onDidTerminateDebugSession((terminatedSession) => {
              if (terminatedSession.id === session.id) {
                clearTimeout(timeout);
                disposable.dispose();
                resolve();
              }
            });

            const timeout = setTimeout(() => {
              disposable.dispose();
              resolve();
            }, 3000);
          });
        });

        await Promise.all(terminationPromises);
        // Wait longer to ensure OS-level debug state is cleared
        // The P_TRACED flag can persist briefly after debugger termination
        await new Promise((resolve) => setTimeout(resolve, 800));
      } catch (e) {
        commonLogger.warn("Failed to terminate debug sessions", { error: e });
      }
    }

    const launchContext = this.context.getWorkspaceState("build.lastLaunchedApp");
    if (!launchContext) {
      throw new Error("No last launched app found, please launch the app first using the SweetPad extension");
    }

    // Pass the "codelldbAttributes" to the lldb debugger
    const codelldbAttributes = config.codelldbAttributes || {};
    for (const [key, value] of Object.entries(codelldbAttributes)) {
      config[key] = value;
    }
    config.codelldbAttributes = undefined;

    if (launchContext.type === "macos") {
      return await this.resolveMacOSDebugConfiguration(config, launchContext);
    }

    if (launchContext.type === "simulator") {
      return await this.resolveSimulatorDebugConfiguration(config, launchContext);
    }

    if (launchContext.type === "device") {
      return await this.resolveDeviceDebugConfiguration(config, launchContext);
    }

    checkUnreachable(launchContext);
    return config;
  }
}

export function registerDebugConfigurationProvider(context: ExtensionContext) {
  const dynamicProvider = new DynamicDebugConfigurationProvider({ context });
  const initialProvider = new InitialDebugConfigurationProvider();
  const disposable1 = vscode.debug.registerDebugConfigurationProvider(
    "sweetpad-lldb",
    initialProvider,
    vscode.DebugConfigurationProviderTriggerKind.Initial,
  );
  const disposable2 = vscode.debug.registerDebugConfigurationProvider(
    "sweetpad-lldb",
    dynamicProvider,
    vscode.DebugConfigurationProviderTriggerKind.Dynamic,
  );

  return {
    dispose() {
      disposable1.dispose();
      disposable2.dispose();
    },
  };
}
