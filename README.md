<p align="center">
  <img src="images/icon.png" alt="UI Font Changer for VS Code" width="128">
</p>

<h1 align="center">UI Font Changer for VS Code</h1>

<p align="center">
  Customize the <strong>Visual Studio Code</strong> interface with your preferred font.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=ch3thanhs.ui-font-changer-for-vscode">
    <img src="https://img.shields.io/badge/VS_Code_Marketplace-Get_It_Now-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white" alt="VS Code Marketplace">
  </a>
</p>

---

**UI Font Changer for VS Code** lets you customize the font used throughout the Visual Studio Code interface, including:

* 🎨 Workbench UI
* 🤖 Chat & Agent windows
* 📝 Markdown Preview

Choose any font installed on your system, apply it with a command, and restart VS Code.

---

## ✨ Features

* Change the VS Code UI font with a single command
* Start setup from a one-time welcome notification after installation
* Reapply the selected font after a VS Code update
* Restore the default UI font at any time
* Supports the Workbench UI, Chat/Agent windows, and Markdown Preview when those surfaces are available in the installed VS Code build
* No manual file editing required

---

## 🚀 Quick Start

### Change the UI Font

1. Install the extension.
2. Start setup using either option:

  * Select **Choose Font** in the welcome notification.
  * Open the **Command Palette** and run **UI Font Changer: Change Font**.

    * **Windows/Linux:** `Ctrl + Shift + P`
    * **macOS:** `⌘ + Shift + P`

3. Select a font from the list or enter one manually.
4. Restart VS Code.

> [!NOTE]
> The selected font must already be installed on your operating system.

### Reapply the UI Font After an Update

1. Open the **Command Palette**.
2. Run **UI Font Changer: Reapply Font**.
3. Restart VS Code.

### Restore the Default Font

1. Open the **Command Palette**.
2. Run **UI Font Changer: Restore Default Font**.
3. Restart VS Code.

---

## 📋 Requirements

* VS Code **1.85.0** or later
* The desired font installed on your system
* Permission to modify the VS Code installation directory
* A local desktop installation of VS Code; browser clients such as `vscode.dev` are not supported

---

## ⚠️ Important

> [!WARNING]
> This extension modifies VS Code installation files to apply your selected UI font.

> [!IMPORTANT]
> After applying a font, VS Code may display the following message:
>
> **"Your Code installation appears to be corrupt."**
>
> This is expected because the extension patches internal VS Code files.

> [!NOTE]
> Updating VS Code restores the original files. If your custom font disappears after an update, run **UI Font Changer: Reapply Font** and restart VS Code.

> [!NOTE]
> Windows is the primary supported platform. macOS and Linux are supported on a best-effort basis.

> [!CAUTION]
> Before uninstalling the extension, run **UI Font Changer: Restore Default Font** and restart VS Code. Uninstalling the extension alone does not restore files that were already modified.

### Permission Recovery

If the extension reports that the VS Code installation directory is protected:

* **Windows:** Close VS Code, right-click its shortcut, select **Run as administrator**, and run the command again.
* **macOS:** Grant your account write access to the application bundle, then run the command again:

  ```bash
  sudo chown -R "$(whoami)" "/Applications/Visual Studio Code.app"
  ```

* **Linux:** Grant your account write access to the installation directory, adjusting the path if VS Code is installed elsewhere:

  ```bash
  sudo chown -R "$(whoami)" /usr/share/code
  ```

Some VS Code releases do not contain every supported UI bundle. The extension reports each surface as updated, partially updated, or unavailable instead of silently claiming full coverage.

---

## 📖 Commands

| Command Palette title                    | Command ID                           | Description                 |
| ---------------------------------------- | ------------------------------------ | --------------------------- |
| UI Font Changer: Change Font             | `ui-font-changer-for-vscode.change`  | Change the VS Code UI font  |
| UI Font Changer: Reapply Font            | `ui-font-changer-for-vscode.reapply` | Reapply the selected font   |
| UI Font Changer: Restore Default Font    | `ui-font-changer-for-vscode.restore` | Restore the default UI font |

---

## 🛠️ Build from Source

```bash
npm ci
npm run check:vscode-font-tokens
npm test
npm run check:vscode-bundles
npx @vscode/vsce package
```

---

> [!NOTE]
> **AI Disclosure**
>
> AI tools were used to assist with the development and documentation of this project.

---

## 🙏 Credits

* **Extension icon:** [Remix Icon – pen-nib-fill](https://remixicon.com/icon/pen-nib-fill)
* **Original font patching technique:** [Improve Your Visual Studio Code's Look with Custom Fonts](https://dev.to/kunaltanwar/how-to-change-vs-code-ui-font-in-windows-5e2e)

---

## 📄 License

Licensed under **The Unlicense**.

See the [LICENSE](LICENSE) file for details.
