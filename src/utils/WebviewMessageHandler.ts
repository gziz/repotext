import * as vscode from "vscode";
import { WorkspaceFileManager } from "./WorkspaceFileManager";
import { PromptGenerator } from "./PromptGenerator";
import { TemplateManager } from './TemplateManager';
import { TokenCounter } from './TokenCounter';
import { ConfigurationManager } from './ConfigurationManager';
import { CONFIG_KEYS } from './constants';

/**
 * Handles communication between the webview and VSCode extension
 */
export class WebviewMessageHandler {
  private _webviewView: vscode.WebviewView;
  private _fileManager: WorkspaceFileManager;
  private _promptGenerator: PromptGenerator;
  private _refreshCallback: () => Promise<void>;
  private _messageListener?: vscode.Disposable;
  private _activeStatusBarMessages: vscode.Disposable[] = [];
  private _templateManager: TemplateManager;
  private _configManager: ConfigurationManager;

  constructor(
    webviewView: vscode.WebviewView,
    fileManager: WorkspaceFileManager,
    promptGenerator: PromptGenerator,
    refreshCallback: () => Promise<void>
  ) {
    this._webviewView = webviewView;
    this._fileManager = fileManager;
    this._promptGenerator = promptGenerator;
    this._refreshCallback = refreshCallback;
    this._templateManager = new TemplateManager(); // No parameters needed
    this._configManager = ConfigurationManager.getInstance();

    // Set up event listeners
    this._setupMessageListeners();
  }

  // Set up event listeners for messages from the webview
  private _setupMessageListeners(): void {
    this._messageListener = this._webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "initialize":
          // Handle initial data request in one go
          await this._refreshCallback();
          // Send templates during initialization
          await this._handleGetSettingsRequest();
          break;
          
        case "openFile":
          // Handle opening a file in VS Code
          await this._handleOpenFileRequest(message.path);
          break;
          
        case "getWorkspaceFiles":
          // Only send workspace files without refreshing everything
          this._sendWorkspaceFiles();
          break;
          
        case "getWorkspaceFolders":
          // Only send workspace folders without refreshing everything
          this._sendWorkspaceFolders();
          break;
          
        case "copyWithContext":
          await this._handleCopyWithContextRequest(
            message.text, 
            message.mentions, 
            message.source || 'editor' // Use provided source or default to 'editor'
          );
          break;
          
        case "calculateTokens":
          await this._handleCalculateTokensRequest(message.mentions);
          break;
          
        case "showMessage":
          this._handleShowMessageRequest(message.text);
          break;
          
        case "saveSettings":
          await this._handleSaveSettingsRequest(message.settings);
          break;
          
        case "getSettings":
          await this._handleGetSettingsRequest();
          break;
          
        case "getDefaultSettings":
          await this._handleGetDefaultSettingsRequest();
          break;
      }
    });
  }

  // Send only workspace files
  private async _sendWorkspaceFiles(): Promise<void> {
    const files = await this._fileManager.getWorkspaceFiles();
    this._webviewView.webview.postMessage({
      command: "workspaceFiles",
      files
    });
  }

  // Send only workspace folders
  private async _sendWorkspaceFolders(): Promise<void> {
    const folders = await this._fileManager.getWorkspaceFolders();
    this._webviewView.webview.postMessage({
      command: "workspaceFolders",
      folders
    });
  }


  // Handle a request to copy prompt with context
  private async _handleCopyWithContextRequest(
    userText: string, 
    mentions: Array<{id: string, label: string, type: string, uniqueId?: string}>,
    source: 'editor' | 'treeView' = 'editor' // Default to editor for backward compatibility
  ): Promise<void> {
    try {
      // Pass the source information directly to the prompt generator
      const prompt = await this._promptGenerator.generatePrompt(
        userText, 
        mentions, 
        { source }
      );
      
      await vscode.env.clipboard.writeText(prompt);
      const statusBarMessage = vscode.window.setStatusBarMessage("Prompt copied to clipboard!");
      this._activeStatusBarMessages.push(statusBarMessage);
      setTimeout(() => {
        statusBarMessage.dispose();
        // Remove from active messages after disposal
        const index = this._activeStatusBarMessages.indexOf(statusBarMessage);
        if (index > -1) {
          this._activeStatusBarMessages.splice(index, 1);
        }
      }, 3000);

    } catch (error) {
      vscode.window.showErrorMessage("Failed to generate prompt: " + (error as Error).message);
    }
  }

  // Handle a request to calculate tokens for selected files/folders
  private async _handleCalculateTokensRequest(
    mentions: Array<{id: string, label: string, type: string, uniqueId?: string}>
  ): Promise<void> {
    try {
      // Use the public method from PromptGenerator to get file contents
      const fileContents = await this._promptGenerator.getFileContentsForTokenCounting(mentions);
      
      // Use the TokenCounter to count tokens in all selected files
      const tokenCount = TokenCounter.countTokensInFiles(fileContents);
      
      // Send the token count back to the webview
      this._webviewView.webview.postMessage({
        command: "tokenCount",
        count: tokenCount
      });
    } catch (error) {
      console.error("Error calculating tokens:", error);
      // Send a message with 0 tokens on error
      this._webviewView.webview.postMessage({
        command: "tokenCount",
        count: 0
      });
    }
  }

  // Handle a request to show a message
  private _handleShowMessageRequest(text: string): void {
    vscode.window.showInformationMessage(text);
  }

  // Handle a request to save settings
  private async _handleSaveSettingsRequest(settings: any): Promise<void> {
    try {
      // Update each setting
      if (settings.excludeHiddenDirectories !== undefined) {
        await this._configManager.updateConfiguration(CONFIG_KEYS.EXCLUDE_HIDDEN_DIRS, settings.excludeHiddenDirectories);
      }
      
      if (settings.respectGitignore !== undefined) {
        await this._configManager.updateConfiguration(CONFIG_KEYS.RESPECT_GITIGNORE, settings.respectGitignore);
      }
      
      if (settings.maxFileSizeMB !== undefined) {
        await this._configManager.updateConfiguration(CONFIG_KEYS.MAX_FILE_SIZE_MB, settings.maxFileSizeMB);
      }
      
      // For templates, we need to convert from TipTap document to string
      if (settings.editorPromptTemplate) {
        const templateString = TemplateManager.documentToString(settings.editorPromptTemplate);
        await this._configManager.updateConfiguration(CONFIG_KEYS.EDITOR_TEMPLATE_STRING, templateString);
      }
      
      if (settings.treeViewPromptTemplate) {
        const templateString = TemplateManager.documentToString(settings.treeViewPromptTemplate);
        await this._configManager.updateConfiguration(CONFIG_KEYS.TREE_VIEW_TEMPLATE_STRING, templateString);
      }
      
      if (settings.fileTemplate) {
        const templateString = TemplateManager.documentToString(settings.fileTemplate);
        await this._configManager.updateConfiguration(CONFIG_KEYS.FILE_TEMPLATE_STRING, templateString);
      }
      
      // Notify the webview that settings were saved
      this._webviewView.webview.postMessage({
        command: "settingsSaved"
      });
      
      vscode.window.showInformationMessage("Settings saved successfully!");
    } catch (error) {
      console.error(`Error saving settings:`, error);
      vscode.window.showErrorMessage("Failed to save settings: " + (error as Error).message);
    }
  }

  // Handle a request to get the current settings
  private async _handleGetSettingsRequest(): Promise<void> {
    try {
      // Load templates from the TemplateManager
      const templates = await this._templateManager.loadTemplates();
      
      // Verify templates contain values (don't proceed with undefined templates)
      if (!templates.editorTemplate || !templates.treeViewTemplate || !templates.fileTemplate) {
        throw new Error('One or more templates are undefined');
      }
      
      // Convert to TipTap documents for the UI
      const editorPromptTemplate = TemplateManager.stringToDocument(templates.editorTemplate);
      const treeViewPromptTemplate = TemplateManager.stringToDocument(templates.treeViewTemplate);
      const fileTemplate = TemplateManager.stringToDocument(templates.fileTemplate);
      
      // Get settings from the configuration manager
      const settings = {
        excludeHiddenDirectories: this._configManager.excludeHiddenDirectories,
        maxFileSizeMB: this._configManager.maxFileSizeMB,
        respectGitignore: this._configManager.respectGitignore,
        editorPromptTemplate,
        treeViewPromptTemplate,
        fileTemplate
      };
      
      this._webviewView.webview.postMessage({ 
        command: "settings",
        settings: settings
      });
    } catch (error) {
      console.error(`Error getting settings:`, error);
      
      // On error, send default templates directly
      const defaultTemplates = TemplateManager.getDefaultTemplates();
      
      const fallbackSettings = {
        excludeHiddenDirectories: false,
        maxFileSizeMB: 5,
        respectGitignore: true,
        editorPromptTemplate: defaultTemplates.editorTemplate,
        treeViewPromptTemplate: defaultTemplates.treeViewTemplate,
        fileTemplate: defaultTemplates.fileTemplate
      };
      
      this._webviewView.webview.postMessage({ 
        command: "settings",
        settings: fallbackSettings
      });
      
      vscode.window.showErrorMessage("Using default templates due to settings error: " + (error as Error).message);
    }
  }

  // Handle a request to get the default settings
  private async _handleGetDefaultSettingsRequest(): Promise<void> {
    try {
      // Get defaults from the TemplateManager
      const defaultTemplates = TemplateManager.getDefaultTemplates();
      
      // Create default settings object
      const defaultSettings = {
        excludeHiddenDirectories: false,
        maxFileSizeMB: 5,
        respectGitignore: true,
        editorPromptTemplate: defaultTemplates.editorTemplate,
        treeViewPromptTemplate: defaultTemplates.treeViewTemplate,
        fileTemplate: defaultTemplates.fileTemplate
      };
      
      this._webviewView.webview.postMessage({ 
        command: "defaultSettings",
        settings: defaultSettings
      });
    } catch (error) {
      console.error(`Error getting default settings:`, error);
      this._webviewView.webview.postMessage({ 
        command: "defaultSettings",
        error: (error as Error).message
      });
      
      vscode.window.showErrorMessage("Failed to get default settings: " + (error as Error).message);
    }
  }

  // Handle a request to open a file in VS Code
  private async _handleOpenFileRequest(path: string): Promise<void> {
    try {
      const fileUri = vscode.Uri.file(path);
      await vscode.workspace.openTextDocument(fileUri).then(doc => vscode.window.showTextDocument(doc));
    } catch (error) {
      console.error(`Error opening file:`, error);
      vscode.window.showErrorMessage("Failed to open file: " + (error as Error).message);
    }
  }

  // Send data to the webview
  public postMessage(message: any): Thenable<boolean> {
    return this._webviewView.webview.postMessage(message);
  }

  // Dispose of all resources
  public dispose(): void {
    // Dispose of message listener
    if (this._messageListener) {
      this._messageListener.dispose();
      this._messageListener = undefined;
    }
    
    // Dispose of any active status bar messages
    for (const message of this._activeStatusBarMessages) {
      message.dispose();
    }
    this._activeStatusBarMessages = [];
  }

  private _showStatusBarMessage(message: string, timeout: number): void {
    const statusBarMessage = vscode.window.setStatusBarMessage(message);
    this._activeStatusBarMessages.push(statusBarMessage);
    setTimeout(() => {
      statusBarMessage.dispose();
      // Remove from active messages after disposal
      const index = this._activeStatusBarMessages.indexOf(statusBarMessage);
      if (index > -1) {
        this._activeStatusBarMessages.splice(index, 1);
      }
    }, timeout);
  }
} 