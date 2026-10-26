// swift-tools-version:5.10
import PackageDescription

// RecorderCore holds the platform-independent protocol, settings and timing logic so it can be unit
// tested anywhere. The executable holds the ScreenCaptureKit / AVFoundation capture code (macOS only).
let package = Package(
    name: "secretary-recorder",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "secretary-recorder", targets: ["secretary-recorder"]),
    ],
    targets: [
        .target(name: "RecorderCore"),
        .executableTarget(
            name: "secretary-recorder",
            dependencies: ["RecorderCore"],
            linkerSettings: [
                // Embed the usage strings so TCC can describe the helper when it is run on its own.
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", Context.packageDirectory + "/Info.plist"], .when(platforms: [.macOS])),
            ]
        ),
        .testTarget(name: "RecorderCoreTests", dependencies: ["RecorderCore"]),
    ],
    swiftLanguageVersions: [.v5]
)
