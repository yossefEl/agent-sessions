"""Open a terminal window in a project directory and run a command there.

This is the one part of agent-sessions that leaves the sandbox of "read the
transcripts and draw them": it starts a process the user asked for. The
server only ever calls it with a directory that is already in the index, so a
request cannot name an arbitrary path — see server.api_launch.
"""

from __future__ import annotations

import os
import platform
import shlex
import shutil
import subprocess


class LaunchError(Exception):
    """Something went wrong starting the terminal, with a message worth showing."""


# Terminals we know how to drive, in the order we would pick them.
MAC_TERMINALS = ["Terminal", "iTerm"]
LINUX_TERMINALS = [
    # (binary, argv builder given a shell command string)
    ("wezterm", lambda cwd, sh: ["wezterm", "start", "--cwd", cwd, "--", "sh", "-lc", sh]),
    ("kitty", lambda cwd, sh: ["kitty", "--directory", cwd, "sh", "-lc", sh]),
    ("alacritty", lambda cwd, sh: ["alacritty", "--working-directory", cwd, "-e", "sh", "-lc", sh]),
    ("gnome-terminal", lambda cwd, sh: ["gnome-terminal", f"--working-directory={cwd}", "--", "sh", "-lc", sh]),
    ("konsole", lambda cwd, sh: ["konsole", "--workdir", cwd, "-e", "sh", "-lc", sh]),
    ("xfce4-terminal", lambda cwd, sh: ["xfce4-terminal", f"--working-directory={cwd}", "-e", f"sh -lc {shlex.quote(sh)}"]),
    ("xterm", lambda cwd, sh: ["xterm", "-e", "sh", "-lc", f"cd {shlex.quote(cwd)} && {sh}"]),
]


def _osa_literal(text: str) -> str:
    """Quote a Python string as an AppleScript string literal.

    Backslash first, or escaping the quotes would then be escaped again.
    """
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _mac_app_installed(name: str) -> bool:
    """True if AppleScript can resolve the app, without launching it."""
    script = f'exists application id (id of application {_osa_literal(name)})'
    try:
        done = subprocess.run(["osascript", "-e", script],
                              capture_output=True, timeout=6)
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


def mac_terminals() -> list[str]:
    return [name for name in MAC_TERMINALS if _mac_app_installed(name)]


def linux_terminals() -> list[str]:
    return [name for name, _ in LINUX_TERMINALS if shutil.which(name)]


def available_terminals() -> list[str]:
    system = platform.system()
    if system == "Darwin":
        return mac_terminals()
    if system == "Linux":
        return linux_terminals()
    return []


def _run_osascript(lines: list[str]) -> None:
    args: list[str] = ["osascript"]
    for line in lines:
        args += ["-e", line]
    try:
        done = subprocess.run(args, capture_output=True, timeout=25)
    except FileNotFoundError:
        raise LaunchError("osascript is not available on this machine")
    except subprocess.SubprocessError as exc:
        raise LaunchError(f"could not talk to the terminal: {exc}")
    if done.returncode != 0:
        detail = done.stderr.decode(errors="replace").strip() or "unknown AppleScript error"
        raise LaunchError(detail)


def _launch_macos(shell_cmd: str, terminal: str | None) -> str:
    installed = mac_terminals()
    if not installed:
        raise LaunchError("no supported terminal found (looked for Terminal and iTerm)")
    app = terminal if terminal and terminal in installed else installed[0]
    payload = _osa_literal(shell_cmd)

    if app == "iTerm":
        _run_osascript([
            'tell application "iTerm"',
            "  activate",
            "  set win to (create window with default profile)",
            f"  tell current session of win to write text {payload}",
            "end tell",
        ])
    else:
        # `do script` with no target opens a new window, which is what we want:
        # reusing the front window would interrupt whatever is running there.
        _run_osascript([
            f'tell application "Terminal" to do script {payload}',
            'tell application "Terminal" to activate',
        ])
    return app


def _launch_linux(cwd: str, shell_cmd: str, terminal: str | None) -> str:
    builders = dict(LINUX_TERMINALS)
    order: list[str] = []
    if terminal and terminal in builders and shutil.which(terminal):
        order.append(terminal)
    order += [name for name, _ in LINUX_TERMINALS
              if shutil.which(name) and name != terminal]
    if not order:
        raise LaunchError("no supported terminal emulator found on PATH")

    last: Exception | None = None
    for name in order:
        try:
            subprocess.Popen(builders[name](cwd, shell_cmd),
                             start_new_session=True,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return name
        except (OSError, subprocess.SubprocessError) as exc:
            last = exc
    raise LaunchError(f"could not start a terminal: {last}")


def launch(cwd: str, command: str = "claude", terminal: str | None = None) -> dict:
    """Open a terminal at `cwd` running `command`.

    Returns {"terminal": app, "cwd": cwd, "command": command}.
    Raises LaunchError with something worth putting in a toast.
    """
    if not cwd or not os.path.isdir(cwd):
        raise LaunchError(f"directory no longer exists: {cwd or '(none)'}")
    command = (command or "claude").strip()
    if not command:
        raise LaunchError("no command to run")

    # One shell string, used by every backend. `exec` keeps the terminal window
    # tied to the agent process rather than leaving a shell behind it.
    shell_cmd = f"cd {shlex.quote(cwd)} && exec {command}"

    system = platform.system()
    if system == "Darwin":
        app = _launch_macos(shell_cmd, terminal)
    elif system == "Linux":
        app = _launch_linux(cwd, shell_cmd, terminal)
    else:
        raise LaunchError(f"launching a terminal is not supported on {system}")
    return {"terminal": app, "cwd": cwd, "command": command}
