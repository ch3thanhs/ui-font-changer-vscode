# UI Font Changer for VS Code


UI Font Changer for VS Code lets you change the VS Code UI font.

It updates the workbench UI, Agents window, and Markdown preview so they use the font you pick.

[![VS Code Marketplace](https://img.shields.io/badge/VS_Code_Marketplace-Get_It_Now-007ACC?style=for-the-badge&logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=ch3thanhs.ui-font-changer-for-vscode)

## Quick Start

1. Install the extension.
2. Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS).
3. Run Change UI font.
4. Pick a font from the dropdown, or type one manually.
5. Restart VS Code.

To revert:

1. Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS).
2. Run Restore UI font.
3. Restart VS Code.

Tip: The font must already be installed on your OS.

## Requirements

- VS Code 1.85.0 or newer
- Installed font on your system
- Write access to the VS Code installation folder

## Important Notes

- This extension patches VS Code installation files.
- You may see a Your Code installation appears to be corrupt warning after patching. This is expected for this extension.
- VS Code updates can overwrite changes, so run Change UI font again after updating VS Code.
- Windows is the main tested platform. macOS/Linux support is best-effort.

## Commands

| Command | Title |
| --- | --- |
| ui-font-changer-for-vscode.change | Change UI font |
| ui-font-changer-for-vscode.restore | Restore UI font |

## Build From Source

```powershell
npm install
npm run compile
npx @vscode/vsce package
```
>[!NOTE]
>**AI Disclosure**
>
>AI tools were used to assist with coding and documentation in this project.

## Credits

- Icon: [Remix Icon — pen-nib-fill](https://remixicon.com/icon/pen-nib-fill) (open source icon library)
- Font change technique: [Improve Your Visual Studio Code's Look with Custom Fonts — DEV Community](https://dev.to/kunaltanwar/how-to-change-vs-code-ui-font-in-windows-5e2e)

## License

This project is licensed under The Unlicense. See [LICENSE](LICENSE).
