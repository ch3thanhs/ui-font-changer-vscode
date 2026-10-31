<p align="center">
  <img src="images/icon.png" alt="UI Font Changer for VS Code" width="128">
</p>

<h1 align="center">UI Font Changer for VS Code</h1>

<p align="center">
  Customize the <strong>Visual Studio Code</strong> interface with your preferred font.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=ch3thanhs.ui-font-changer-for-vscode"><img src="https://img.shields.io/badge/VS_Code_Marketplace-Get_It_Now-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white" alt="VS Code Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=ch3thanhs.ui-font-changer-for-vscode"><img src="https://vsmarketplacebadges.dev/version/ch3thanhs.ui-font-changer-for-vscode.svg?style=for-the-badge&label=Marketplace%20Version" alt="VS Code Marketplace Version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=ch3thanhs.ui-font-changer-for-vscode"><img src="https://vsmarketplacebadges.dev/installs/ch3thanhs.ui-font-changer-for-vscode.svg?style=for-the-badge&label=Marketplace%20Installs" alt="VS Code Marketplace Installs"></a>
</p>

<p align="center">
  <a href="https://open-vsx.org/extension/ch3thanhs/ui-font-changer-for-vscode"><img src="https://img.shields.io/badge/Open_VSX-Get_It_Now-2C2255?style=for-the-badge" alt="Open VSX"></a>
  <a href="https://open-vsx.org/extension/ch3thanhs/ui-font-changer-for-vscode"><img src="https://img.shields.io/open-vsx/v/ch3thanhs/ui-font-changer-for-vscode?style=for-the-badge&label=Open%20VSX%20Version&color=4b0" alt="Open VSX Version"></a>
  <a href="https://open-vsx.org/extension/ch3thanhs/ui-font-changer-for-vscode"><img src="https://img.shields.io/open-vsx/dt/ch3thanhs/ui-font-changer-for-vscode?style=for-the-badge&label=Open%20VSX%20Downloads&color=4b0" alt="Open VSX Downloads"></a>
</p>

## Quick Start

### Change the UI Font

1. Install the extension.
2. Start setup using either option:

   * Select **Choose Font** in the welcome notification.
   * Open the **Command Palette** and run **UI Font Changer: Change Font**.

     * **Windows/Linux:** `Ctrl + Shift + P`
     * **macOS:** `⌘ + Shift + P`

3. Select a font from the list or enter one manually.
4. Restart VS Code.

> [!IMPORTANT]
> After applying a font, VS Code may display the following message:
>
> **"Your Code installation appears to be corrupt."**
>
> This is expected because the extension patches internal VS Code files.
>
> To hide this notification in the future, select its gear icon and choose **Don't Show Again**.

## Commands

| Command Palette title                    | Command ID                           | Description                 |
| ---------------------------------------- | ------------------------------------ | --------------------------- |
| UI Font Changer: Change Font             | `ui-font-changer-for-vscode.change`  | Change the VS Code UI font  |
| UI Font Changer: Reapply Font            | `ui-font-changer-for-vscode.reapply` | Reapply the selected font   |
| UI Font Changer: Restore Default Font    | `ui-font-changer-for-vscode.restore` | Restore the default UI font |

## Build from Source

```bash
npm ci
npm run check:vscode-font-tokens
npm test
npm run check:vscode-bundles
npx @vscode/vsce package
```

> [!NOTE]
> **AI Disclosure**
>
> AI tools were used to assist with the development and documentation of this project.

## Credits

* **Extension icon:** [Remix Icon – pen-nib-fill](https://remixicon.com/icon/pen-nib-fill)
* **Original font patching technique:** [Improve Your Visual Studio Code's Look with Custom Fonts](https://dev.to/kunaltanwar/how-to-change-vs-code-ui-font-in-windows-5e2e)

## License

Licensed under **The Unlicense**.

See the [LICENSE](LICENSE) file for details.
