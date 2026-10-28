// swift-tools-version:5.10
import PackageDescription

// The Touch ID approval key: a Secure Enclave P-256 key that signs owner approvals (Secretary's /v1/approvals).
let package = Package(
    name: "secretary-approver",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "secretary-approver", targets: ["secretary-approver"]),
    ],
    targets: [
        .executableTarget(
            name: "secretary-approver",
            linkerSettings: [
                // The Touch ID prompt names the app from this plist ("Secretary Code is trying to approve …").
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", Context.packageDirectory + "/Info.plist"], .when(platforms: [.macOS])),
            ]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
