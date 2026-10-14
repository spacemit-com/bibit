// Load boundary for @uiw/react-textarea-code-editor: rehype-prism-plus pulls in
// refractor with every Prism grammar (~1 MB) and the editor's stylesheet. Only
// three dialogs use it, so it must not ride along in the first-paint bundle.
import CodeEditor from '@uiw/react-textarea-code-editor'
import '@uiw/react-textarea-code-editor/dist.css'

export default CodeEditor
