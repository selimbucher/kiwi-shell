export default function filterApp(name: string): string {
    switch (name) {
        case "code":
            return "vscode"
        default:
            return name
    }
}