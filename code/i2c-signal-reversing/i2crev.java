///usr/bin/env jbang "$0" "$@" ; exit $?

import java.util.ArrayList;
import java.util.List;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.stream.Stream;

class i2crev {
    static List<Integer> dataFrames = new ArrayList<>();
    static int RS = 0x01;
    static int EN = 0x04;

    public static void main(String... args) {
       Path path = Paths.get("bytes.txt");
       try(Stream<String> lines = Files.lines(path)) {
         lines.forEach(s -> {
             int value = Integer.decode(s);
             if(((value & RS) != 0) && ((value & EN) != 0)) {
               dataFrames.add(value);
             }
         });
       } catch(IOException e) {
         System.err.println("An error occurred while reading the file: " + e.getMessage());
         e.printStackTrace();
       }

       int size = dataFrames.size() - 1;
       for(int i = 0; i < size; i += 2) {
          int upperNibble = dataFrames.get(i)  & 0xF0;
          int lowerNibble = dataFrames.get(i + 1) >> 4;
          System.out.println(Character.toString((char)(upperNibble | lowerNibble)));
       }
    }
}
