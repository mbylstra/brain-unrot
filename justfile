set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# List the available commands.
default:
    @just --list

# Install the pinned pnpm dependencies (requires Node.js and Corepack).
[working-directory: 'vscode']
setup:
    corepack pnpm install --frozen-lockfile

# Rebuild the extension and its webview.
[working-directory: 'vscode']
build:
    corepack pnpm run build

# Run tests and the TypeScript check.
[working-directory: 'vscode']
check:
    corepack pnpm test
    corepack pnpm typecheck

# Rebuild and package a VSIX with a stable filename.
[working-directory: 'vscode']
package:
    corepack pnpm run package --out brain-unrot.vsix

# Rebuild, package, and reinstall in VS Code, including the same version.
[working-directory: 'vscode']
reinstall: package
    code --install-extension brain-unrot.vsix --force
    @echo 'Run Developer: Reload Window in VS Code to load the updated extension.'
