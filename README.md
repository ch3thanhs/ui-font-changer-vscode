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
* Restore the default UI font at any time
* Supports the Workbench UI, Chat/Agent windows, and Markdown Preview
* No manual file editing required

---

## 🚀 Quick Start

### Change the UI Font

1. Install the extension.
2. Open the **Command Palette**:

   * **Windows/Linux:** `Ctrl + Shift + P`
   * **macOS:** `⌘ + Shift + P`
3. Run **Change UI font**.
4. Select a font from the list or enter one manually.
5. Restart VS Code.

> [!NOTE]
> The selected font must already be installed on your operating system.

### Restore the Default Font

1. Open the **Command Palette**.
2. Run **Restore UI font**.
3. Restart VS Code.

---

## 📋 Requirements

* VS Code **1.85.0** or later
* The desired font installed on your system
* Permission to modify the VS Code installation directory

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
> Updating VS Code restores the original files. If your custom font disappears after an update, simply run **Change UI font** again and restart VS Code.

> [!NOTE]
> Windows is the primary supported platform. macOS and Linux are supported on a best-effort basis.

---

## 📖 Commands

| Command                              | Description                 |
| ------------------------------------ | --------------------------- |
| `ui-font-changer-for-vscode.change`  | Change the VS Code UI font  |
| `ui-font-changer-for-vscode.restore` | Restore the default UI font |

---

## 🛠️ Build from Source

```bash
npm install
npm run compile
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
