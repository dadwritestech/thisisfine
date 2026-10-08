// Command notes keeps a list of notes in notes.txt in the current directory.
//
// Used by thisisfine's walkthrough and end-to-end test. It ships with a bug
// on purpose: --dry-run is accepted and then ignored.
//
//	notes add "buy milk" [--dry-run]
//	notes list
package main

import (
	"fmt"
	"os"
	"strings"
)

const file = "notes.txt"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: notes add <text> [--dry-run] | notes list")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "add":
		var words []string
		for _, a := range os.Args[2:] {
			if a != "--dry-run" {
				words = append(words, a)
			}
		}
		if len(words) == 0 {
			fmt.Fprintln(os.Stderr, "notes add: nothing to add")
			os.Exit(2)
		}
		note := strings.Join(words, " ")
		f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		defer f.Close()
		fmt.Fprintln(f, note)
		fmt.Printf("added: %s\n", note)
	case "list":
		b, err := os.ReadFile(file)
		if err != nil && !os.IsNotExist(err) {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Print(string(b))
	default:
		fmt.Fprintf(os.Stderr, "notes: unknown command %q\n", os.Args[1])
		os.Exit(2)
	}
}
