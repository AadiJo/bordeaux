package frc.robot;

import dev.bordeaux.runtime.BordeauxBindings;
import dev.bordeaux.runtime.BordeauxCommandRegistry;
import dev.bordeaux.runtime.BordeauxEventRunner;
import dev.bordeaux.runtime.BordeauxPathEvents;
import dev.bordeaux.runtime.BordeauxTrajectoryReader;
import edu.wpi.first.wpilibj.Filesystem;
import java.io.IOException;
import java.nio.file.Files;

// Illustrative team-owned wiring. Bordeaux never edits RobotContainer.
public final class RobotContainerSnippet {
    private final RobotCommands actions;
    private final BordeauxCommandRegistry bordeauxCommands;
    private BordeauxEventRunner bordeauxEvents;

    public RobotContainerSnippet(RobotCommands.Superstructure superstructure) {
        actions = new RobotCommands(superstructure);
        bordeauxCommands = BordeauxBindings.generated(actions);
    }

    public void startPath(String fileName, String pathId) throws IOException {
        try (var input = Files.newInputStream(Filesystem.getDeployDirectory().toPath().resolve(fileName))) {
            BordeauxPathEvents path = BordeauxTrajectoryReader.read(input, pathId);
            bordeauxEvents = new BordeauxEventRunner(path, bordeauxCommands);
        }
    }

    // Pass the follower's elapsed time and monotonic measured progress from 0 to 1.
    public void pathPeriodic(double elapsedS, double measuredFraction) {
        if (bordeauxEvents != null) bordeauxEvents.periodic(elapsedS, measuredFraction);
    }

    public void endPath() {
        if (bordeauxEvents != null) bordeauxEvents.endPath();
        bordeauxEvents = null;
    }
}
