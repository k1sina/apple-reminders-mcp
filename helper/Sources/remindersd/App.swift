import Foundation

@main
struct Main {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let cmd = args.first else {
            printErr(ErrorDTO(error: "missing command", hint: "usage: remindersd <auth-check|request-access|lists|reminders|reminder>"))
            exit(2)
        }

        let client = EventKitClient()

        switch cmd {
        case "auth-check":
            printJSON(client.authStatus())

        case "request-access":
            do {
                try await client.requestAccess()
                printJSON(client.authStatus())
            } catch {
                printErr(ErrorDTO(
                    error: "Reminders access denied or unavailable: \(error)",
                    hint: "Grant access in System Settings → Privacy & Security → Reminders."
                ))
                exit(3)
            }

        case "lists":
            ensureAuthorized(client)
            printJSON(client.lists())

        case "reminders":
            ensureAuthorized(client)
            var listId: String? = nil
            var status: String = "open"
            var i = 1
            while i < args.count {
                let a = args[i]
                switch a {
                case "--list":
                    if i + 1 < args.count { listId = args[i + 1]; i += 2 } else { i += 1 }
                case "--status":
                    if i + 1 < args.count { status = args[i + 1]; i += 2 } else { i += 1 }
                default:
                    i += 1
                }
            }
            if !["open", "completed", "all"].contains(status) {
                printErr(ErrorDTO(error: "invalid --status \(status)", hint: "expected one of: open, completed, all"))
                exit(2)
            }
            let rs = await client.reminders(listId: listId, status: status)
            printJSON(rs)

        case "reminder":
            ensureAuthorized(client)
            var id: String? = nil
            var i = 1
            while i < args.count {
                if args[i] == "--id", i + 1 < args.count { id = args[i + 1]; i += 2 } else { i += 1 }
            }
            guard let id else {
                printErr(ErrorDTO(error: "missing --id", hint: "usage: remindersd reminder --id <x-coredata://...>"))
                exit(2)
            }
            if let r = await client.reminder(id: id) {
                printJSON(r)
            } else {
                printErr(ErrorDTO(error: "not found", hint: nil))
                exit(4)
            }

        default:
            printErr(ErrorDTO(error: "unknown command: \(cmd)", hint: "valid: auth-check, request-access, lists, reminders, reminder"))
            exit(2)
        }
    }

    static func ensureAuthorized(_ client: EventKitClient) {
        let s = client.authStatus()
        if !s.granted {
            printErr(ErrorDTO(
                error: "Reminders access not granted (status: \(s.status))",
                hint: "Run `remindersd request-access` once to trigger the macOS prompt, or grant manually in System Settings → Privacy & Security → Reminders."
            ))
            exit(3)
        }
    }

    static func printJSON<T: Encodable>(_ value: T) {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        do {
            let data = try enc.encode(value)
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0A])) // trailing newline
        } catch {
            printErr(ErrorDTO(error: "JSON encode failed: \(error)", hint: nil))
            exit(5)
        }
    }

    static func printErr<T: Encodable>(_ value: T) {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        if let data = try? enc.encode(value) {
            FileHandle.standardError.write(data)
            FileHandle.standardError.write(Data([0x0A]))
        }
    }
}
