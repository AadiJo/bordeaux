package frc.robot;

import dev.bordeaux.runtime.BordeauxBindings;
import dev.bordeaux.runtime.BordeauxCommandRegistry;
import dev.bordeaux.runtime.BordeauxEventRunner;
import dev.bordeaux.runtime.BordeauxPathEvents;
import dev.bordeaux.runtime.BordeauxTrajectoryReader;
import edu.wpi.first.wpilibj.Filesystem;
import frc.robot.commands.ExampleCommands;
import frc.robot.subsystems.ExampleSubsystem;
import java.io.IOException;
import java.nio.file.Files;

public final class RobotContainer {
    private final ExampleSubsystem exampleSubsystem = new ExampleSubsystem();
    private final ExampleCommands exampleCommands = new ExampleCommands(exampleSubsystem);
    private final BordeauxCommandRegistry commandRegistry =
            BordeauxBindings.generated(exampleCommands);

    private BordeauxEventRunner eventRunner;
    private double pathDurationS;

    public void startBordeauxPath(String fileName, String pathIdOrName) throws IOException {
        endBordeauxPath();
        var trajectory = Filesystem.getDeployDirectory().toPath()
                .resolve("bordeaux")
                .resolve(fileName);
        try (var input = Files.newInputStream(trajectory)) {
            BordeauxPathEvents path = BordeauxTrajectoryReader.read(input, pathIdOrName);
            eventRunner = new BordeauxEventRunner(path, commandRegistry);
            pathDurationS = path.totalTimeS();
        }
    }

    /** Simulation fallback for this drivetrain-free template. Real robots should pass measured progress. */
    public boolean pollBordeauxEvents(double elapsedS) {
        double plannedFraction = pathDurationS > 0
                ? Math.max(0, Math.min(1, elapsedS / pathDurationS))
                : 0;
        return pollBordeauxEvents(elapsedS, plannedFraction);
    }

    /** Processes the final event tick using monotonic measured path progress from 0 to 1. */
    public boolean pollBordeauxEvents(double elapsedS, double measuredFraction) {
        if (eventRunner == null) return false;
        eventRunner.periodic(elapsedS, measuredFraction);
        if (elapsedS + 1e-9 >= pathDurationS) {
            endBordeauxPath();
            return false;
        }
        return true;
    }

    public void endBordeauxPath() {
        if (eventRunner != null) eventRunner.endPath();
        eventRunner = null;
        pathDurationS = 0;
    }

    public ExampleSubsystem exampleSubsystem() {
        return exampleSubsystem;
    }
}
