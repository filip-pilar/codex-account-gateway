import Foundation

struct LoginAttempt {
    let accountID: String
    let label: String
    let completionURL: URL
    enum Result: Equatable { case waiting, succeeded, failed }
    func result(exitCode: Int?, accounts: [Account]) -> Result {
        guard let exitCode else { return .waiting }
        guard exitCode == 0 else { return .failed }
        return accounts.contains { $0.id == accountID && $0.authenticated } ? .succeeded : .waiting
    }
}
