# Container Build

Build a container image, scan it for vulnerabilities with [Trivy](https://trivy.dev) and push it to a registry, all in one task with minimal configuration.

```yaml
steps:
  - task: ContainerBuild@1
    inputs:
      image: myacr.azurecr.io/my-app
      containerRegistry: my-acr-connection   # Docker Registry service connection
```

That's it. The task:

1. **Builds** `./Dockerfile` and tags it automatically (short commit SHA, plus `latest` on main/master, the git tag on tag builds, `pr-<n>` for pull requests or the branch name).
2. **Scans** the image with Trivy for `CRITICAL` and `HIGH` vulnerabilities that have a fix available. If any are found the task fails and **nothing is pushed**.
3. **Pushes** all tags (skipped automatically for pull request builds) and sets the `digest` and `imageRef` output variables.

A summary of the scan is attached to the build results page.

See the [documentation](https://github.com/onek8s/container-build-extension#readme) for all options.
