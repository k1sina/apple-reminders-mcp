// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "remindersd",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "remindersd",
            path: "Sources/remindersd",
            exclude: ["Info.plist"],
            linkerSettings: [
                // Embed Info.plist into the __TEXT,__info_plist section so EventKit can read the
                // NSRemindersFullAccessUsageDescription string and prompt the user properly.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/remindersd/Info.plist"
                ])
            ]
        )
    ]
)
