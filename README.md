# VS Code Submodule Cloner

VS Code's long missing submodule cloner powered by isomorphic-git.

> [!WARNING]
> This extension is still in the early stages of development. The file layout and exported API may change in an incompatible way.

This extension provides a basic set of commands for cloning submodule content without requiring git command-line access. This is particularly useful on VS Code for the Web, although it should function similarly to a local Git client in desktop environments.

The extension operates on one of the two modes:

* **Standard mode**: This mode tries to replicate the behaviour of canonical Git, cloning a bare repository into the `.git/modules/<name>` directory and checking out the working tree to each submodule directory. You can browse the content in place. This is the default mode.
* **Out-of-tree clone mode**: This mode is chosen when you are opening a virtual workspace via the [Remote Repositories](https://marketplace.visualstudio.com/items?itemName=GitHub.remotehub) extension by Microsoft. To save your GitHub API usage limits:
  * In this mode, this extension never bulk-writes to your working tree. Blobs are written to a persistent storage provided by VS Code instead. This includes a bare clone to the original repo where we extract the commit hash of each submodule.
  * The submodules are placed elsewhere, so they will not be accessible via the file explorer, but it will persist across page reloads. To browse the content, you need to create a workspace and add the (virtual) folder to it.

APIs for querying and locating the submodules is WIP. For example, in out-of-tree clone mode, you can write a router to rewrite URIs to submodules to the virtual one.

## Related issues

* [microsoft/vscode-remote-repositories-github#291](https://github.com/microsoft/vscode-remote-repositories-github/issues/291)
* [microsoft/vscode-remote-repositories-github#298](https://github.com/microsoft/vscode-remote-repositories-github/issues/298), closed as "not planned".
* [microsoft/vscode#52700](https://github.com/microsoft/vscode/issues/52700).

## What this is not

This extension is not intended to provide complete Git support. **The usage is supposed to be read-only**: you should not stage, checkout, or make commits in the cloned git submodules. You can always inspect the submodule with a git client, and wipe it whenever it gets corrupted, just like a naive git user.

This extension is designed for use with [the WebAssembly edition](https://github.com/andy0130tw/vscode-als-wasm-loader) of [agda-mode-vscode](https://github.com/banacorn/agda-mode-vscode) and may not open to all feature requests.

For advanced usage, consider [github1s](https://github.com/conwnet/github1s/), which has supported submodule browsing out of the box [since 2021](https://github.com/conwnet/github1s/issues/143).

# On the use of CORS proxies

In VS Code for the Web, we use [isomorphic-git](https://isomorphic-git.org/) along with its default [CORS proxy](https://github.com/isomorphic-git/cors-proxy) to clone repositories to workaround [CORS limitations](https://code.visualstudio.com/api/extension-guides/web-extensions#web-extension-main-file). Configure your own endpoint if you want to use it with private repos, or when security is a major concern.
