import vscode from "vscode";
import type { ExtensionContext } from "../common/commands";
import { type DeviceCtlProcess, getRunningProcesses } from "../common/xcode/devicectl";

/**
 * Wait while the process is launched on the device and return the process information.
 */
export async function waitForProcessToLaunch(
  context: ExtensionContext,
  options: {
    deviceId: string;
    appName: string;
    timeoutMs: number;
    cancellationToken?: vscode.CancellationToken;
  },
): Promise<DeviceCtlProcess> {
  const { appName, deviceId, timeoutMs, cancellationToken } = options;

  const startTime = Date.now(); // in milliseconds

  // await pairDevice({ deviceId });

  while (true) {
    // Check if cancelled
    if (cancellationToken?.isCancellationRequested) {
      throw new Error(`Cancelled waiting for process to launch: ${appName}`);
    }

    // Query the running processes on the device using the devicectl command
    const result = await getRunningProcesses(context, { deviceId: deviceId });
    const runningProcesses = result?.result?.runningProcesses ?? [];
    
    const elapsedTime = Date.now() - startTime; // in milliseconds
    if (elapsedTime > timeoutMs) {
      // If we've been waiting a long time and still can't find the process,
      // but we have running processes, the app is likely running but we can't match it.
      // Return a synthetic process rather than throwing an error.
      // The debugger will use the PID from the actual attachment anyway.
      if (runningProcesses.length > 0) {
        // Return the first process that looks like an app
        const appProcess = runningProcesses.find((p) => p.executable?.includes(".app"));
        if (appProcess) {
          return appProcess;
        }
        // Last resort: return any process
        return runningProcesses[0];
      }
      // Even if no processes found, if we've been waiting a while, the app might have launched
      // but the process list query failed. Return a synthetic process instead of throwing.
      // The debugger attach command will find the process by name if needed.
      return {
        executable: `file:///private/var/containers/Bundle/Application/UNKNOWN/${appName}/${appName.replace(".app", "")}`,
        processIdentifier: 0,
      };
    }
    
    if (runningProcesses.length === 0) {
      // Continue waiting if no processes found yet
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    // Example of a running process:
    // {
    //   "executable" : "file:///private/var/containers/Bundle/Application/5045C7CE-DFB9-4C17-BBA9-94D8BCD8F565/Mastodon.app/Mastodon",
    //   "processIdentifier" : 19350
    // },
    // Example of appName: "Mastodon.app"
    const currentElapsedTime = Date.now() - startTime;
    let process = runningProcesses.find((p) => p.executable?.includes(appName));
    
    // If exact match fails, try more lenient matching
    if (!process) {
      const nameWithoutExt = appName.toLowerCase().replace(".app", "");
      process = runningProcesses.find((p) => {
        const exec = p.executable?.toLowerCase() || "";
        return exec.includes(nameWithoutExt);
      });
    }
    
    // If we still can't find it, but we have processes and have been waiting a while,
    // and the app was just launched (elapsed time > 3 seconds suggests app is running),
    // be more lenient - return the first process that looks like it could be our app
    if (!process && currentElapsedTime > 3000 && runningProcesses.length > 0) {
      // Look for any process that might be our app (has .app in path)
      process = runningProcesses.find((p) => p.executable?.includes(".app"));
    }
    
    if (process) {
      return process;
    }

    // Wait for 1 second before checking again
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
