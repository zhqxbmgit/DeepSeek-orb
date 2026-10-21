declare module 'electron' {
  interface Rectangle {
    x: number
    y: number
    width: number
    height: number
  }

  interface Display {
    bounds: Rectangle
    workArea: Rectangle
    scaleFactor: number
  }

  interface WebContents {
    setWindowOpenHandler(handler: () => { action: 'deny' }): void
    on(
      event: 'will-navigate' | 'did-finish-load',
      listener: (event: { preventDefault(): void }) => void,
    ): void
    executeJavaScript(code: string): Promise<unknown>
  }

  interface BrowserWindow {
    loadFile(path: string): Promise<void>
    setContentProtection(enable: boolean): void
    setAlwaysOnTop(flag: boolean, level?: string): void
    setVisibleOnAllWorkspaces(flag: boolean, options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }): void
    setBounds(bounds: Rectangle): void
    getBounds(): Rectangle
    getNativeWindowHandle(): Buffer
    isVisible(): boolean
    isDestroyed(): boolean
    showInactive(): void
    hide(): void
    setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void
    webContents: WebContents
  }

  interface BrowserWindowOptions {
    width?: number
    height?: number
    frame?: boolean
    transparent?: boolean
    alwaysOnTop?: boolean
    resizable?: boolean
    movable?: boolean
    minimizable?: boolean
    maximizable?: boolean
    fullscreenable?: boolean
    skipTaskbar?: boolean
    hasShadow?: boolean
    focusable?: boolean
    show?: boolean
    backgroundColor?: string
    roundedCorners?: boolean
    type?: string
    webPreferences?: {
      contextIsolation?: boolean
      nodeIntegration?: boolean
      sandbox?: boolean
    }
  }

  export const BrowserWindow: new (options: BrowserWindowOptions) => BrowserWindow

  export const app: {
    whenReady(): Promise<void>
    quit(): void
    dock?: { hide(): void }
    on(event: 'before-quit' | 'window-all-closed', listener: () => void): void
  }

  export const screen: {
    getDisplayNearestPoint(point: { x: number; y: number }): Display
    screenToDipRect(window: null, rect: Rectangle): Rectangle
    on(event: 'display-added' | 'display-removed' | 'display-metrics-changed', listener: () => void): void
  }
}
