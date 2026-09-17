// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "GatewayBar",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "GatewayBar", targets: ["GatewayBar"])],
    targets: [.executableTarget(name: "GatewayBar"), .testTarget(name: "GatewayBarTests", dependencies: ["GatewayBar"])],
    swiftLanguageModes: [.v5]
)
