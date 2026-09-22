import Quarrel from "gi://Quarrel"
import app from "ags/gtk4/app"
import { setLogLevel } from "./log"

// kiwictl command dispatch, parsed with Quarrel. Option/flag objects keep
// their parsed state, so the command tree is rebuilt for every request —
// a handful of GObjects, nothing worth caching.
//
// The switchers and Spotlight have no commands: their keys send kiwi's global
// shortcuts (widgets/services/globalShortcuts.ts), which is also how a custom
// key reaches them. A command was a second way to the same thing, and a key
// bound both ways opened and closed in one press.

function buildCli() {
    const help = Quarrel.SpecialFlag.new("help", "h".charCodeAt(0), "Print help")

    const quit = Quarrel.Command.new("quit")
        .about("Quit the shell")
        .opt(help)

    const debug = Quarrel.Command.new("debug")
        .about("Enable debug logging for this shell instance")
        .opt(help)

    const cli = Quarrel.Command.new("kiwictl")
        .about("Control a running Kiwi Shell")
        .example("kiwictl debug")
        .subcommand(quit)
        .subcommand(debug)
        .opt(help)

    return { cli, help, quit, debug }
}

export function handleCliRequest(argv: string[], respond: (response: string) => void) {
    const c = buildCli()

    let matched: Quarrel.Command
    try {
        // argv[0] is expected to be the program name and skipped by parse
        matched = c.cli.parse(["kiwictl", ...argv])
    } catch (e: any) {
        const failed = Quarrel.Command.throwing() ?? c.cli
        respond(`${e.message ?? e}\n\n${Quarrel.help(failed)}`)
        return
    }

    // bare `kiwictl` and any --help print usage
    if (c.help.enabled || matched === c.cli) {
        respond(Quarrel.help(matched))
        return
    }

    if (matched === c.debug) {
        setLogLevel("debug")
        respond("debug logging enabled")
        return
    }

    if (matched === c.quit) {
        // reply before quitting so the client is not left hanging
        respond("")
        app.quit()
    }
}
