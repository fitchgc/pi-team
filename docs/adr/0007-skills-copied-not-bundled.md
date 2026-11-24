# Matt skills are copied at init, never bundled in the package

The package does not ship Matt Pocock's skill directories. `/team init` copies the skills a project needs from the user's own local skill directory into the project's `.pi/skills/`.

The local skill copies carry no license file, so redistributing them inside a public package would publish someone else's work without a clear license. Copying at init keeps the author's skills where they already are, keeps the package free of third-party content, and still gives every project the playbooks the roles preload. If the upstream skills gain an explicit license later, bundling can be reconsidered.
