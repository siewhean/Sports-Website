export async function terminateChildTree(childProcess) {
  if (childProcess === undefined) return;

  if (process.platform === "linux" && childProcess.pid !== undefined) {
    if (signalProcessGroup(childProcess.pid, "SIGTERM")) {
      await waitForProcessGroupExit(childProcess.pid, 5_000);
      if (processGroupExists(childProcess.pid)) {
        signalProcessGroup(childProcess.pid, "SIGKILL");
        await waitForProcessGroupExit(childProcess.pid, 1_000);
      }
    } else {
      await terminateChild(childProcess);
    }
  } else {
    if (childProcess.exitCode === null && childProcess.signalCode === null) {
      childProcess.kill("SIGTERM");
      await waitForExit(childProcess, 5_000);
    }
    if (childProcess.exitCode === null && childProcess.signalCode === null) {
      childProcess.kill("SIGKILL");
      await waitForExit(childProcess, 1_000);
    }
  }

  childProcess.stdout?.destroy();
  childProcess.stderr?.destroy();
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw error;
  }
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processGroupExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForExit(childProcess, timeoutMs) {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      childProcess.off("exit", onExit);
      resolve();
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    childProcess.once("exit", onExit);
  });
}

async function terminateChild(childProcess) {
  if (childProcess.exitCode === null && childProcess.signalCode === null) {
    childProcess.kill("SIGTERM");
    await waitForExit(childProcess, 5_000);
  }
  if (childProcess.exitCode === null && childProcess.signalCode === null) {
    childProcess.kill("SIGKILL");
    await waitForExit(childProcess, 1_000);
  }
}
